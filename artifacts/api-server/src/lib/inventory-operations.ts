/**
 * Inventory operations shared by the HTTP routes, the bots and the invoice flow.
 *
 * Everything that changes stock lives here: batch-aware receipts, write-offs,
 * FIFO consumption and the bouquet cost recalculation that follows a price
 * change. Callers import these instead of keeping private copies, so a movement
 * cannot be recorded one way through the web interface and another through a bot.
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import {
  assistantMessagesTable,
  bouquetComponentsTable,
  db,
  movementBatchAllocationsTable,
  movementsTable,
  productsTable,
  usersTable,
} from "@workspace/db";
import type { CreateMovementBody } from "@workspace/api-zod";
import { consumeBatchesFifo, ensureBatchBalances } from "./inventory-batches";

export const nullable = (value: string | undefined) => value || null;
export const dateOnly = (value: Date | string | null | undefined) =>
  value instanceof Date ? value.toISOString().slice(0, 10) : value;
export const salePrice = (cost: number, markupPercent: number) =>
  Math.round(cost * (1 + markupPercent / 100) * 100) / 100;
export const money = (value: number) => Math.round(value * 100) / 100;
export const normalizeAlias = (value: string) =>
  value.trim().toLocaleLowerCase("ru").replaceAll("ё", "е").replace(/\s+/gu, " ");

export function cleanAliases(aliases: string[] | undefined) {
  const unique = new Map<string, string>();
  for (const alias of aliases ?? []) {
    const trimmed = alias.trim().replace(/\s+/gu, " ");
    if (trimmed) unique.set(normalizeAlias(trimmed), trimmed);
  }
  return [...unique.values()];
}

export async function assertAliasesAvailable(
  tx: any,
  aliases: string[],
  excludedProductId?: number,
) {
  if (!aliases.length) return;
  await tx.execute(sql`select pg_advisory_xact_lock(704271)`);
  const products = await tx
    .select({ id: productsTable.id, name: productsTable.name, aliases: productsTable.aliases })
    .from(productsTable);
  const requested = new Set(aliases.map(normalizeAlias));
  const conflict = products.find(
    (product: { id: number; name: string; aliases: string[] }) =>
      product.id !== excludedProductId &&
      product.aliases.some((alias) => requested.has(normalizeAlias(alias))),
  );
  if (conflict) {
    throw new Error(
      `Один из псевдонимов уже используется для товара «${conflict.name}». Укажите другое название.`,
    );
  }
}

export async function withBatchAllocations(rows: Array<typeof movementsTable.$inferSelect>) {
  if (!rows.length) return [];
  const authorIds = [
    ...new Set(rows.map((row) => row.createdBy).filter((id): id is number => id !== null)),
  ];
  const authors = authorIds.length
    ? await db
        .select({ id: usersTable.id, displayName: usersTable.displayName })
        .from(usersTable)
        .where(inArray(usersTable.id, authorIds))
    : [];
  const authorNames = new Map(authors.map((author) => [author.id, author.displayName]));
  // Единица измерения живёт на товаре, а движение её не копирует: без неё
  // уведомление «Продажа: Роза −2» не говорит, штуки это, стебли или упаковки.
  const unitRows = await db
    .select({ id: productsTable.id, unit: productsTable.unit })
    .from(productsTable)
    .where(inArray(productsTable.id, [...new Set(rows.map((row) => row.productId))]));
  const units = new Map(unitRows.map((row) => [row.id, row.unit]));
  const allocations = await db
    .select({
      movementId: movementBatchAllocationsTable.movementId,
      receiptMovementId: movementBatchAllocationsTable.receiptMovementId,
      quantity: movementBatchAllocationsTable.quantity,
      unitPrice: movementsTable.unitPrice,
      batchArrivalDate: movementsTable.batchArrivalDate,
      cutDate: movementsTable.cutDate,
      expiresAt: movementsTable.expiresAt,
      supplier: productsTable.supplier,
    })
    .from(movementBatchAllocationsTable)
    .innerJoin(
      movementsTable,
      eq(movementBatchAllocationsTable.receiptMovementId, movementsTable.id),
    )
    .innerJoin(productsTable, eq(movementsTable.productId, productsTable.id))
    .where(
      inArray(
        movementBatchAllocationsTable.movementId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(movementsTable.batchArrivalDate), asc(movementsTable.id));
  return rows.map((row) => {
    const batchAllocations = allocations
      .filter((allocation) => allocation.movementId === row.id)
      .map(({ movementId: _, ...allocation }) => ({
        ...allocation,
        lineCost: money(allocation.quantity * allocation.unitPrice),
      }));
    return {
      ...row,
      // Единица товара нужна интерфейсу для уведомления об операции. Если товар
      // удалён окончательно, подставляем «ед.» — движение всё равно показывается.
      unit: units.get(row.productId) ?? "ед.",
      createdByName: row.createdBy ? authorNames.get(row.createdBy) ?? null : null,
      totalCost: batchAllocations.length
        ? money(batchAllocations.reduce((sum, allocation) => sum + allocation.lineCost, 0))
        : money(row.quantity * row.unitPrice),
      batchAllocations,
    };
  });
}

export async function recalculateDependentBouquets(tx: any, componentProductId: number) {
  const dependencies = await tx
    .select({ bouquetProductId: bouquetComponentsTable.bouquetProductId })
    .from(bouquetComponentsTable)
    .where(eq(bouquetComponentsTable.componentProductId, componentProductId));
  for (const dependency of dependencies) {
    const [bouquet] = await tx
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, dependency.bouquetProductId));
    const components = await tx
      .select({
        quantity: bouquetComponentsTable.quantity,
        averagePrice: productsTable.averagePrice,
      })
      .from(bouquetComponentsTable)
      .innerJoin(
        productsTable,
        eq(bouquetComponentsTable.componentProductId, productsTable.id),
      )
      .where(
        eq(
          bouquetComponentsTable.bouquetProductId,
          dependency.bouquetProductId,
        ),
      );
    const cost = Math.round(
      components.reduce(
        (sum: number, item: { quantity: number; averagePrice: number }) =>
          sum + item.quantity * item.averagePrice,
        0,
      ) * 100,
    ) / 100;
    await tx
      .update(productsTable)
      .set({
        purchasePrice: cost,
        averagePrice: cost,
        salePrice: salePrice(cost, bouquet.markupPercent),
      })
      .where(eq(productsTable.id, bouquet.id));
  }
}

export async function recalculateProductFromBatches(tx: any, productId: number) {
  const [product] = await tx
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, productId));
  if (!product) throw new Error("Товар не найден");
  const batches = await tx
    .select()
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.productId, productId),
        inArray(movementsTable.type, ["receipt", "production_output"]),
      ),
    )
    .orderBy(desc(movementsTable.batchArrivalDate), desc(movementsTable.createdAt));
  const currentStock = batches.reduce(
    (
      sum: number,
      batch: { remainingQuantity: number | null; unitPrice: number },
    ) => sum + (batch.remainingQuantity ?? 0),
    0,
  );
  const inventoryValue = batches.reduce(
    (
      sum: number,
      batch: { remainingQuantity: number | null; unitPrice: number },
    ) => sum + (batch.remainingQuantity ?? 0) * batch.unitPrice,
    0,
  );
  const averagePrice = currentStock > 0 ? inventoryValue / currentStock : 0;
  await tx
    .update(productsTable)
    .set({
      currentStock,
      averagePrice,
      // Закупочная цена держится вместе со средней: у позиции, собранной из
      // партий, «последняя закупка» и средняя — это одно и то же число, и
      // расхождение между ними только путало бы карточку товара.
      purchasePrice: averagePrice,
      salePrice: salePrice(averagePrice, product.markupPercent),
    })
    .where(eq(productsTable.id, productId));
  await recalculateDependentBouquets(tx, productId);
}

export type AssistantMovementMessage = {
  conversationId: string;
  build: (movement: typeof movementsTable.$inferSelect) => {
    content: string;
    action: string;
  };
};

/**
 * Applies one inventory operation inside an existing transaction.
 *
 * The invoice route needs to write many receipts atomically, so the operation
 * itself is transaction-agnostic; `addMovement` wraps it for the single-movement
 * endpoints.
 */
export async function applyMovement(
  tx: any,
  input: typeof CreateMovementBody._type,
  assistantMessage?: AssistantMovementMessage,
  options?: {
    skipBouquetRecalculation?: boolean;
    authorId?: number | null;
    /** Positions written by one assistant command share this id. */
    assistantBatchId?: string | null;
  },
) {
  const [product] = await tx
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, input.productId))
    .for("update");
  if (!product) throw new Error("Товар не найден");
  const incoming = input.type === "receipt";
  // Букет продаётся и списывается только из конкретной сборки: у каждой свой
  // состав и своя себестоимость, и «средний» расход размазал бы её по всем.
  if (
    !incoming &&
    product.productType === "bouquet" &&
    !input.productionBatchId
  ) {
    throw new Error(
      "Выберите сборку букета: у каждой свой состав и своя себестоимость",
    );
  }
  const delta = incoming ? input.quantity : -input.quantity;
  // A chosen batch is checked before the total stock: telling the user that the
  // selected delivery is short by N is more useful than "not enough stock" when
  // the shop as a whole has plenty.
  const allocations = !incoming
    ? await consumeBatchesFifo(tx, product.id, input.quantity, {
        fromReceiptId: input.receiptMovementId ?? null,
        // Букет расходуется из конкретной сборки: у каждой свой состав и цена.
        fromProductionBatchId:
          product.productType === "bouquet" ? input.productionBatchId ?? null : null,
      })
    : [];
  if (!incoming && product.currentStock < input.quantity) {
    throw new Error("Недостаточно товара на складе");
  }
  const unitPrice = input.unitPrice ?? product.purchasePrice;
  const actualSaleUnitPrice =
    input.type === "expense" ? input.saleUnitPrice ?? product.salePrice : null;
  const markupPercent =
    incoming && input.markupPercent !== undefined
      ? input.markupPercent
      : product.markupPercent;
  const newAverage =
    incoming && product.currentStock + input.quantity > 0
      ? (product.currentStock * product.averagePrice + input.quantity * unitPrice) /
        (product.currentStock + input.quantity)
      : product.averagePrice;
  await tx
    .update(productsTable)
    .set({
      currentStock: product.currentStock + delta,
      averagePrice: newAverage,
      purchasePrice: incoming ? unitPrice : product.purchasePrice,
      markupPercent,
      salePrice: incoming ? salePrice(newAverage, markupPercent) : product.salePrice,
    })
    .where(eq(productsTable.id, product.id));
  if (incoming && !options?.skipBouquetRecalculation) {
    await recalculateDependentBouquets(tx, product.id);
  }
  const arrival =
    dateOnly(input.batchArrivalDate) ?? new Date().toISOString().slice(0, 10);
  const expiresAt =
    incoming && product.shelfLifeDays
      ? new Date(new Date(`${arrival}T12:00:00Z`).getTime() + product.shelfLifeDays * 86400000)
          .toISOString()
          .slice(0, 10)
      : null;
  const { markupPercent: _markupPercent, productionBatchId: _productionBatchId, ...movementInput } =
    input;
  const [movement] = await tx
    .insert(movementsTable)
    .values({
      ...movementInput,
      productName: product.name,
      remainingQuantity: incoming ? input.quantity : null,
      unitPrice,
      saleUnitPrice: actualSaleUnitPrice,
      // The markup in force on the position after this operation, so a receipt
      // card can show and edit it without another lookup.
      markupPercent,
      previousPurchasePrice: product.purchasePrice,
      previousMarkupPercent: product.markupPercent,
      orderNumber: nullable(input.orderNumber),
      batchArrivalDate: incoming ? arrival : dateOnly(input.batchArrivalDate) ?? null,
      cutDate: dateOnly(input.cutDate) ?? null,
      expiresAt,
      // Which batch was consumed is recorded in the allocations below, not here:
      // `production_batch_id` marks the batch an operation *created*, and an
      // expense creates nothing. Writing the chosen batch here would make the
      // batch look produced twice.
      productionBatchId: null,
      // Who performed the operation; null for the movements recorded before
      // accounts existed.
      createdBy: options?.authorId ?? null,
      // Set only for a composite assistant command, where all its positions
      // must be revertible together.
      assistantBatchId: options?.assistantBatchId ?? null,
    })
    .returning();
  if (allocations.length) {
    await tx.insert(movementBatchAllocationsTable).values(
      allocations.map((allocation) => ({
        movementId: movement.id,
        receiptMovementId: allocation.receiptMovementId,
        quantity: allocation.quantity,
      })),
    );
  }
  if (assistantMessage) {
    const message = assistantMessage.build(movement);
    await tx.insert(assistantMessagesTable).values({
      conversationId: assistantMessage.conversationId,
      role: "assistant",
      content: message.content,
      action: message.action,
      movementId: movement.id,
    });
  }
  return movement;
}

export async function addMovement(
  input: typeof CreateMovementBody._type,
  assistantMessage?: AssistantMovementMessage,
  authorId?: number | null,
  assistantBatchId?: string | null,
) {
  return db.transaction((tx) =>
    applyMovement(tx, input, assistantMessage, { authorId, assistantBatchId }),
  );
}

export async function editReceipt(
  movementId: number,
  changes: {
    quantity?: number;
    unitPrice?: number;
    markupPercent?: number;
    reason?: string;
    batchArrivalDate?: Date | string;
    expiresAt?: Date | string | null;
  },
) {
  return db.transaction(async (tx) => {
    const [movement] = await tx
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.id, movementId));
    if (!movement || movement.type !== "receipt") {
      throw new Error("Приход не найден");
    }
    const [product] = await tx
      .select()
      .from(productsTable)
      .where(eq(productsTable.id, movement.productId));
    if (!product) throw new Error("Товар прихода не найден");
    await ensureBatchBalances(tx, product.id);
    const [initializedMovement] = await tx
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.id, movement.id));
    if (!initializedMovement) throw new Error("Приход не найден");
    const usedQuantity =
      initializedMovement.quantity - (initializedMovement.remainingQuantity ?? 0);
    const quantity = changes.quantity ?? movement.quantity;
    const unitPrice = changes.unitPrice ?? movement.unitPrice;
    if (quantity <= 0 || unitPrice < 0) throw new Error("Неверные данные прихода");
    // The markup belongs to the position, not to the batch, so a receipt can
    // correct it after the fact: the shop sets it once the supplier invoice is
    // known, which is often after the goods were booked in.
    const markupPercent = changes.markupPercent ?? product.markupPercent;
    if (markupPercent < 0) throw new Error("Наценка не может быть отрицательной");
    if (quantity < usedQuantity) {
      throw new Error(
        `Нельзя установить меньше ${usedQuantity}: это количество уже израсходовано из партии`,
      );
    }
    const [updated] = await tx
      .update(movementsTable)
      .set({
        quantity,
        remainingQuantity: quantity - usedQuantity,
        unitPrice,
        reason: changes.reason ?? movement.reason,
        batchArrivalDate:
          changes.batchArrivalDate === undefined
            ? movement.batchArrivalDate
            : dateOnly(changes.batchArrivalDate),
        expiresAt:
          changes.expiresAt === undefined ? movement.expiresAt : dateOnly(changes.expiresAt),
      })
      .where(eq(movementsTable.id, movement.id))
      .returning();

    const receipts = await tx
      .select()
      .from(movementsTable)
      .where(
        and(
          eq(movementsTable.productId, product.id),
          eq(movementsTable.type, "receipt"),
        ),
      )
      .orderBy(desc(movementsTable.batchArrivalDate), desc(movementsTable.createdAt));
    const nextStock = receipts.reduce(
      (sum, receipt) => sum + (receipt.remainingQuantity ?? 0),
      0,
    );
    const remainingValue = receipts.reduce(
      (sum, receipt) =>
        sum + (receipt.remainingQuantity ?? 0) * receipt.unitPrice,
      0,
    );
    const nextAverage = nextStock > 0 ? remainingValue / nextStock : 0;
    await tx
      .update(productsTable)
      .set({
        currentStock: nextStock,
        purchasePrice: receipts[0]?.unitPrice ?? product.purchasePrice,
        averagePrice: nextAverage,
        markupPercent,
        salePrice: salePrice(nextAverage, markupPercent),
      })
      .where(eq(productsTable.id, product.id));
    // Every receipt of the position carries the markup in force, so the card
    // shows the current value instead of the one captured when it was created.
    await tx
      .update(movementsTable)
      .set({ markupPercent })
      .where(
        and(
          eq(movementsTable.productId, product.id),
          eq(movementsTable.type, "receipt"),
        ),
      );
    await recalculateDependentBouquets(tx, product.id);
    return { ...updated, markupPercent };
  });
}
/** Creates a stock product inside an existing transaction. */
export async function createProductWithin(
  tx: any,
  input: {
    name: string;
    aliases?: string[];
    category: string;
    variety?: string | null;
    color?: string | null;
    originCountry?: string | null;
    supplier?: string | null;
    unit: string;
    minimumStock: number;
    purchasePrice: number;
    markupPercent: number;
    shelfLifeDays: number;
  },
) {
  const aliases = cleanAliases(input.aliases);
  await assertAliasesAvailable(tx, aliases);
  const [created] = await tx
    .insert(productsTable)
    .values({
      name: input.name,
      aliases,
      category: input.category,
      productType: "stock",
      variety: nullable(input.variety ?? undefined),
      color: nullable(input.color ?? undefined),
      originCountry: nullable(input.originCountry ?? undefined),
      supplier: nullable(input.supplier ?? undefined),
      unit: input.unit,
      minimumStock: input.minimumStock,
      purchasePrice: input.purchasePrice,
      averagePrice: input.purchasePrice,
      markupPercent: input.markupPercent,
      salePrice: salePrice(input.purchasePrice, input.markupPercent),
      shelfLifeDays: input.shelfLifeDays,
    })
    .returning();
  return created;
}

/** Returns the existing product for a name/alias, if the catalog already has it. */
export async function findProductByAlias(tx: any, name: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(704271)`);
  const rows = await tx
    .select({ id: productsTable.id, name: productsTable.name, aliases: productsTable.aliases })
    .from(productsTable);
  const target = normalizeAlias(name);
  const match = rows.find(
    (product: { id: number; name: string; aliases: string[] }) =>
      normalizeAlias(product.name) === target ||
      product.aliases.some((alias) => normalizeAlias(alias) === target),
  );
  return match as { id: number; name: string } | undefined;
}
