import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gt, ilike, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import {
  assistantConversationsTable,
  assistantMessagesTable,
  bouquetComponentsTable,
  db,
  movementBatchAllocationsTable,
  movementsTable,
  productsTable,
  usersTable,
} from "@workspace/db";
import {
  ApplyAssistantCommandPlanBody,
  ApplyAssistantCommandPlanResponse,
  CreateMovementBody,
  CreateMovementResponse,
  CreateProductBody,
  CreateProductResponse,
  GetAssistantConversationParams,
  GetAssistantConversationResponse,
  GetDashboardResponse,
  ListMovementsQueryParams,
  ListMovementsResponse,
  ListProductsQueryParams,
  ListProductsResponse,
  RunAssistantCommandBody,
  RunAssistantCommandResponse,
  UndoAssistantBatchBody,
  UndoAssistantBatchParams,
  UndoAssistantBatchResponse,
  UndoAssistantOperationBody,
  UndoMovementParams,
  UndoMovementResponse,
  UndoAssistantOperationParams,
  UndoAssistantOperationResponse,
  UpdateReceiptBody,
  UpdateReceiptParams,
  UpdateReceiptResponse,
  UpdateProductBody,
  UpdateProductParams,
  UpdateProductResponse,
} from "@workspace/api-zod";
import { consumeBatchesFifo, ensureBatchBalances } from "../lib/inventory-batches";
import { applyAssistantPlan, planAssistantCommand } from "../lib/assistant";
import { requireRole } from "../middlewares/auth";
import {
  addMovement,
  applyMovement,
  assertAliasesAvailable,
  cleanAliases,
  createProductWithin,
  dateOnly,
  editReceipt,
  findProductByAlias,
  money,
  nullable,
  normalizeAlias,
  recalculateDependentBouquets,
  recalculateProductFromBatches,
  salePrice,
  withBatchAllocations,
} from "../lib/inventory-operations";

const router: IRouter = Router();


router.get("/products", async (req, res): Promise<void> => {
  const parsed = ListProductsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, category, lowStock, includeArchived, archived } = parsed.data;
  const filters = [
    // По умолчанию архивные товары скрыты: они не должны мешать в списке.
    // archived=true показывает только архив, includeArchived=true — вместе с ним.
    archived
      ? isNotNull(productsTable.archivedAt)
      : includeArchived
        ? undefined
        : isNull(productsTable.archivedAt),
    search
      ? or(
          ilike(productsTable.name, `%${search}%`),
          ilike(productsTable.variety, `%${search}%`),
          ilike(productsTable.color, `%${search}%`),
          // Aliases are how the store actually refers to goods, so they must be
          // searchable too — the AI matching layer relies on the same names.
          sql`exists (select 1 from unnest(${productsTable.aliases}) as alias where alias ilike ${`%${search}%`})`,
        )
      : undefined,
    category ? eq(productsTable.category, category) : undefined,
    lowStock ? lte(productsTable.currentStock, productsTable.minimumStock) : undefined,
  ].filter(Boolean);
  const rows = await db
    .select()
    .from(productsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(asc(productsTable.name));
  const receiptDates = rows.length
    ? await db
        .select({
          productId: movementsTable.productId,
          lastReceiptDate: sql<string | null>`max(${movementsTable.batchArrivalDate})`,
        })
        .from(movementsTable)
        .where(eq(movementsTable.type, "receipt"))
        .groupBy(movementsTable.productId)
    : [];
  const lastReceiptByProduct = new Map(
    receiptDates.map((receipt) => [receipt.productId, receipt.lastReceiptDate]),
  );
  res.json(
    ListProductsResponse.parse(
      rows.map((product) => ({
        ...product,
        lastReceiptDate: lastReceiptByProduct.get(product.id) ?? null,
      })),
    ),
  );
});

router.post("/products", requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = CreateProductBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const product = await db.transaction((tx) =>
      createProductWithin(tx, {
        name: parsed.data.name,
        aliases: parsed.data.aliases,
        category: parsed.data.category,
        variety: parsed.data.variety,
        color: parsed.data.color,
        originCountry: parsed.data.originCountry,
        supplier: parsed.data.supplier,
        unit: parsed.data.unit,
        minimumStock: parsed.data.minimumStock,
        purchasePrice: parsed.data.purchasePrice,
        markupPercent: parsed.data.markupPercent,
        shelfLifeDays: parsed.data.shelfLifeDays,
      }),
    );
    res.status(201).json(CreateProductResponse.parse(product));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Конфликт псевдонима" });
  }
});

// The product helpers live in ../lib/inventory-operations, next to the movement
// writers that use them.

router.patch("/products/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  const body = UpdateProductBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Неверные данные товара" });
    return;
  }
  const [existing] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, params.data.id));
  if (!existing) {
    res.status(404).json({ error: "Товар не найден" });
    return;
  }
  if (existing.productType !== "stock") {
    res.status(400).json({ error: "Редактируйте букет в разделе «Букеты»" });
    return;
  }
  let product;
  try {
    product = await db.transaction(async (tx) => {
      const aliases =
        body.data.aliases === undefined ? undefined : cleanAliases(body.data.aliases);
      if (aliases) await assertAliasesAvailable(tx, aliases, params.data.id);
      const [updated] = await tx
        .update(productsTable)
        .set({ ...body.data, aliases })
        .where(eq(productsTable.id, params.data.id))
        .returning();
      await recalculateDependentBouquets(tx, params.data.id);
      return updated;
    });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : "Конфликт псевдонима" });
    return;
  }
  if (!product) {
    res.status(404).json({ error: "Товар не найден" });
    return;
  }
  res.json(UpdateProductResponse.parse(product));
});

router.delete("/products/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Неверный идентификатор товара" });
    return;
  }
  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, params.data.id));
  if (!product) {
    res.status(404).json({ error: "Товар не найден" });
    return;
  }
  // Букет без истории и без остатка удаляется: он ничего не значит ни для
  // аналитики, ни для склада. С историей — уходит в архив, как и товар.
  if (product.productType === "bouquet") {
    const [bouquetMovement] = await db
      .select({ id: movementsTable.id })
      .from(movementsTable)
      .where(eq(movementsTable.productId, product.id))
      .limit(1);
    if (bouquetMovement) {
      await db
        .update(productsTable)
        .set({ archivedAt: new Date() })
        .where(eq(productsTable.id, product.id));
      res.status(204).send();
      return;
    }
    await db.delete(productsTable).where(eq(productsTable.id, product.id));
    res.status(204).send();
    return;
  }
  if (product.currentStock !== 0) {
    res.status(400).json({
      error: `Сначала обнулите остаток товара. Сейчас на складе: ${product.currentStock} ${product.unit}`,
    });
    return;
  }
  const [recipeUsage] = await db
    .select({ id: bouquetComponentsTable.id })
    .from(bouquetComponentsTable)
    .where(eq(bouquetComponentsTable.componentProductId, product.id))
    .limit(1);
  if (recipeUsage) {
    res.status(400).json({ error: "Товар используется в составе букета" });
    return;
  }
  const [movement] = await db
    .select({ id: movementsTable.id })
    .from(movementsTable)
    .where(eq(movementsTable.productId, product.id))
    .limit(1);
  // Товар с историей операций удалять нельзя: аналитика потеряет данные, а
  // отчёты за прошлые месяцы перестанут сходиться. Такой товар уходит в архив —
  // исчезает из работы, но остаётся в базе вместе со своей историей.
  if (movement) {
    await db
      .update(productsTable)
      .set({ archivedAt: new Date() })
      .where(eq(productsTable.id, product.id));
    res.status(204).send();
    return;
  }
  // Товар без истории удаляется окончательно: хранить его незачем.
  await db.delete(productsTable).where(eq(productsTable.id, product.id));
  res.status(204).send();
});

/** Возвращает товар из архива. */
router.post("/products/:id/restore", requireRole("admin"), async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Неверный идентификатор товара" });
    return;
  }
  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, params.data.id));
  if (!product) {
    res.status(404).json({ error: "Товар не найден" });
    return;
  }
  await db
    .update(productsTable)
    .set({ archivedAt: null })
    .where(eq(productsTable.id, product.id));
  const [restored] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, product.id));
  // archivedAt приходит null, но схема ответа допускает и отсутствие поля:
  // подставляем null явно, чтобы клиент видел «не в архиве», а не undefined.
  res.json(UpdateProductResponse.parse({ ...restored, archivedAt: restored.archivedAt ?? null }));
});

router.get("/products/:id/receipts", async (req, res): Promise<void> => {
  const params = UpdateProductParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Неверный идентификатор товара" });
    return;
  }
  const [product] = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.id, params.data.id));
  if (!product) {
    res.status(404).json({ error: "Товар не найден" });
    return;
  }
  const receipts = await db.transaction(async (tx) => {
    await ensureBatchBalances(tx, product.id);
    return tx
      .select()
      .from(movementsTable)
      .where(
        and(
          eq(movementsTable.productId, product.id),
          eq(movementsTable.type, "receipt"),
        ),
      )
      .orderBy(desc(movementsTable.batchArrivalDate), desc(movementsTable.createdAt));
  });
  res.json(ListMovementsResponse.parse(await withBatchAllocations(receipts)));
});

router.get("/movements", async (req, res): Promise<void> => {
  const parsed = ListMovementsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const limit = parsed.data.limit ?? 50;
  const search = parsed.data.search?.trim();
  const conditions = [
    parsed.data.type ? eq(movementsTable.type, parsed.data.type) : undefined,
    // Поиск по названию товара и комментарию идёт по всей истории, а не по
    // загруженной странице: иначе фильтр вводил бы в заблуждение.
    search
      ? or(
          ilike(movementsTable.productName, `%${search}%`),
          ilike(movementsTable.reason, `%${search}%`),
        )
      : undefined,
  ].filter(Boolean);
  const where = conditions.length ? and(...(conditions as never[])) : undefined;

  // Сортировка тоже на сервере: при листании порядок должен быть сквозным.
  const sortColumn = {
    date: movementsTable.createdAt,
    type: movementsTable.type,
    product: movementsTable.productName,
    quantity: movementsTable.quantity,
    reason: movementsTable.reason,
  }[parsed.data.sort ?? "date"];
  const direction = parsed.data.direction === "asc" ? asc : desc;

  const rows = await db
    .select()
    .from(movementsTable)
    .where(where)
    .orderBy(direction(sortColumn), desc(movementsTable.id))
    .limit(limit)
    .offset(parsed.data.offset ?? 0);
  res.json(ListMovementsResponse.parse(await withBatchAllocations(rows)));
});

type AssistantMovementMessage = {
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
 * endpoints. When several receptions of the same product land in one batch, the
 * caller should call `recalculateDependentBouquets` once at the end instead of
 * after every line.
 */

router.patch("/movements/:id/receipt", async (req, res): Promise<void> => {
  const params = UpdateReceiptParams.safeParse(req.params);
  const body = UpdateReceiptBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Неверные данные прихода" });
    return;
  }
  try {
    const movement = await editReceipt(params.data.id, body.data);    const [movementWithAllocations] = await withBatchAllocations([movement]);
    res.json(UpdateReceiptResponse.parse(movementWithAllocations));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Ошибка изменения прихода";
    res.status(message === "Приход не найден" ? 404 : 400).json({ error: message });
  }
});

router.post("/movements", async (req, res): Promise<void> => {
  const parsed = CreateMovementBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const movement = await addMovement(parsed.data, undefined, req.user?.id);
    const [movementWithAllocations] = await withBatchAllocations([movement]);
    res.status(201).json(CreateMovementResponse.parse(movementWithAllocations));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : "Ошибка операции" });
  }
});

router.get("/dashboard", async (_req, res): Promise<void> => {
  const allProducts = await db.select().from(productsTable).orderBy(asc(productsTable.name));
  // Архивные товары не должны всплывать нигде: их убрали из работы, и «низкий
  // остаток» по ним — это подсказка купить то, что магазин больше не продаёт.
  // Остаток меняется только через операции, а операция требует остатка, поэтому
  // архивный товар всегда с нулём; без фильтра он попадал в сводку навсегда.
  const products = allProducts.filter((item) => item.archivedAt === null);
  await db.transaction(async (tx) => {
    for (const product of allProducts) {
      if (product.productType === "stock") {
        await ensureBatchBalances(tx, product.id);
      }
    }
  });
  const recentMovementRows = await db
    .select()
    .from(movementsTable)
    .orderBy(desc(movementsTable.createdAt))
    .limit(8);
  const recentMovements = await withBatchAllocations(recentMovementRows);
  // Порог берётся только у позиций, у которых он задан: `minimumStock = 0` — это
  // «порога нет», а не «всё ниже порога». Без этого условия товар с нулевым
  // порогом и нулевым остатком (а архивный всегда такой) висел в низком остатке
  // вечно. Та же логика — в `isLowStock` на клиенте.
  const lowStock = products.filter(
    (item) => item.minimumStock > 0 && item.currentStock <= item.minimumStock,
  );
  const today = new Date();
  const inThreeDays = new Date(today.getTime() + 3 * 86400000).toISOString().slice(0, 10);
  const batches = await db
    .select()
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.type, "receipt"),
        lte(movementsTable.expiresAt, inThreeDays),
        gt(movementsTable.remainingQuantity, 0),
      ),
    )
    .orderBy(asc(movementsTable.expiresAt));
  const activeIds = new Set(products.map((item) => item.id));
  const expiring = batches
    // Партия архивного товара тоже не должна звать на склад.
    .filter((item) => item.expiresAt && activeIds.has(item.productId))
    .map((item) => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.remainingQuantity ?? 0,
      expiresAt: item.expiresAt!,
      daysLeft: Math.ceil(
        (new Date(`${item.expiresAt}T12:00:00Z`).getTime() - today.getTime()) / 86400000,
      ),
    }));
  res.json(
    GetDashboardResponse.parse({
      totalProducts: products.length,
      totalUnits: products.reduce((sum, item) => sum + item.currentStock, 0),
      inventoryValue: products.reduce(
        (sum, item) => sum + item.currentStock * item.averagePrice,
        0,
      ),
      lowStockCount: lowStock.length,
      expiringCount: expiring.length,
      lowStock,
      expiring,
      recentMovements,
    }),
  );
});

router.get("/assistant/conversations/:conversationId", async (req, res): Promise<void> => {
  const parsed = GetAssistantConversationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверный идентификатор диалога" });
    return;
  }
  const messages = await db
    .select()
    .from(assistantMessagesTable)
    .where(eq(assistantMessagesTable.conversationId, parsed.data.conversationId))
    .orderBy(asc(assistantMessagesTable.createdAt), asc(assistantMessagesTable.id));
  const operationIds = messages
    .map((message) => message.movementId)
    .filter((id): id is number => id !== null);
  const movements = operationIds.length
    ? await db
        .select()
        .from(movementsTable)
        .where(inArray(movementsTable.id, operationIds))
    : [];
  const reversals = operationIds.length
    ? await db
        .select({ reversalOfMovementId: movementsTable.reversalOfMovementId })
        .from(movementsTable)
        .where(inArray(movementsTable.reversalOfMovementId, operationIds))
    : [];
  const reversedIds = new Set(reversals.map((row) => row.reversalOfMovementId));
  const latestOperationId = [...messages]
    .reverse()
    .find((message) => message.movementId !== null)?.movementId ?? null;
  const movementsById = new Map(movements.map((movement) => [movement.id, movement]));
  const latestMovement = movements.find((movement) => movement.id === latestOperationId);
  const [laterMovement] = latestMovement
    ? await db
        .select({ id: movementsTable.id })
        .from(movementsTable)
        .where(
          and(
            eq(movementsTable.productId, latestMovement.productId),
            gt(movementsTable.id, latestMovement.id),
          ),
        )
        .limit(1)
    : [];
  const latestCanUndo =
    latestMovement !== undefined &&
    !reversedIds.has(latestMovement.id) &&
    !laterMovement &&
    ["receipt", "expense", "writeoff", "production_input"].includes(latestMovement.type) &&
    (latestMovement.type !== "receipt" ||
      latestMovement.remainingQuantity === latestMovement.quantity);

  // An invoice produces one receipt per line, so a single "latest operation"
  // rule would leave every line but the last one permanently stuck. Each line is
  // independently revertible for as long as nothing later moved the product.
  const invoiceMovements = messages
    .filter((message) => message.action === "invoice_receipt_created")
    .map((message) => message.movementId)
    .filter((id): id is number => id !== null);
  const invoiceUndoable = new Map<number, boolean>();
  for (const movementId of new Set(invoiceMovements)) {
    const movement = movementsById.get(movementId);
    if (!movement || reversedIds.has(movement.id)) {
      invoiceUndoable.set(movementId, false);
      continue;
    }
    const [laterForProduct] = await db
      .select({ id: movementsTable.id })
      .from(movementsTable)
      .where(
        and(
          eq(movementsTable.productId, movement.productId),
          gt(movementsTable.id, movement.id),
        ),
      )
      .limit(1);
    invoiceUndoable.set(movementId, !laterForProduct);
  }

  res.json(GetAssistantConversationResponse.parse({
    id: parsed.data.conversationId,
    messages: messages.map(({ movementId, invoiceMetadata, ...message }) => {
      const metadata = parseInvoiceMetadata(invoiceMetadata);
      return {
        ...message,
        operationId: movementId,
        canUndo:
          movementId === latestOperationId && latestCanUndo
            ? true
            : Boolean(movementId !== null && invoiceUndoable.get(movementId)),
        ...(metadata.draft ? { invoiceDraft: metadata.draft } : {}),
        ...(metadata.imageThumbnail ? { imageThumbnail: metadata.imageThumbnail } : {}),
        ...(message.action === "invoice_recognized" || message.action === "invoice_applied"
          ? {
              invoiceReview: {
                status: message.action === "invoice_applied" ? "applied" : "pending",
                appliedCount: metadata.appliedCount ?? null,
              },
            }
          : {}),
      };
    }),
  }));
});

type InvoiceMessageMetadata = {
  draft?: unknown;
  appliedCount?: number | null;
  imageThumbnail?: string;
};

function parseInvoiceMetadata(value: string | null): InvoiceMessageMetadata {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as InvoiceMessageMetadata;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

router.delete("/assistant/conversations/:conversationId", async (req, res): Promise<void> => {
  const parsed = GetAssistantConversationParams.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверный идентификатор диалога" });
    return;
  }
  await db
    .delete(assistantConversationsTable)
    .where(eq(assistantConversationsTable.id, parsed.data.conversationId));
  res.status(204).send();
});

/**
 * Собирает отмену операции, записанной ассистентом.
 *
 * `protectBatch` — идентификатор отменяемого набора: позиции того же набора не
 * считаются «более поздними движениями» и не блокируют отмену друг друга.
 */
async function buildUndoReversal(
  tx: any,
  original: typeof movementsTable.$inferSelect,
  options: { protectBatch?: string | null },
) {
  await tx
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.id, original.productId))
    .for("update");
  const [locked] = await tx
    .select()
    .from(movementsTable)
    .where(eq(movementsTable.id, original.id))
    .for("update");
  if (!locked) throw new Error("Операция не найдена");
  const [existingReversal] = await tx
    .select({ id: movementsTable.id })
    .from(movementsTable)
    .where(eq(movementsTable.reversalOfMovementId, locked.id));
  if (existingReversal) {
    const error = new Error("Эта операция уже отменена");
    error.name = "AlreadyUndone";
    throw error;
  }
  if (!["receipt", "expense", "writeoff", "production_input"].includes(locked.type)) {
    throw new Error("Эту операцию нельзя отменить");
  }
  const [laterMovement] = await tx
    .select({
      id: movementsTable.id,
      batchId: movementsTable.assistantBatchId,
    })
    .from(movementsTable)
    .where(
      and(eq(movementsTable.productId, locked.productId), gt(movementsTable.id, locked.id)),
    )
    .orderBy(asc(movementsTable.id))
    .limit(1);
  const sameBatch =
    laterMovement?.batchId !== null &&
    laterMovement?.batchId !== undefined &&
    laterMovement.batchId === options.protectBatch;
  if (laterMovement && !sameBatch) {
    throw new Error("Нельзя отменить операцию: после неё уже были движения этого товара");
  }

  await ensureBatchBalances(tx, locked.productId);
  const allocations: Array<{ receiptMovementId: number; quantity: number }> = await tx
    .select()
    .from(movementBatchAllocationsTable)
    .where(eq(movementBatchAllocationsTable.movementId, locked.id));
  const undoingIncoming = locked.type === "receipt";
  if (undoingIncoming) {
    if ((locked.remainingQuantity ?? 0) < locked.quantity) {
      throw new Error("Нельзя отменить приход: товар из этой партии уже использован");
    }
    await tx
      .update(movementsTable)
      .set({
        remainingQuantity: sql`${movementsTable.remainingQuantity} - ${locked.quantity}`,
      })
      .where(eq(movementsTable.id, locked.id));
  } else {
    if (!allocations.length) {
      throw new Error("Не найдены FIFO-партии исходной операции");
    }
    for (const allocation of allocations) {
      await tx
        .update(movementsTable)
        .set({
          remainingQuantity: sql`${movementsTable.remainingQuantity} + ${allocation.quantity}`,
        })
        .where(eq(movementsTable.id, allocation.receiptMovementId));
    }
  }

  const [reversal] = await tx
    .insert(movementsTable)
    .values({
      productId: locked.productId,
      productName: locked.productName,
      type: undoingIncoming ? "writeoff" : "receipt",
      quantity: locked.quantity,
      remainingQuantity: undoingIncoming ? null : 0,
      unitPrice: locked.unitPrice,
      saleUnitPrice: locked.saleUnitPrice,
      reason: `Отмена AI-операции №${locked.id}`,
      // Отмена наследует пометку «не в статистике»: обе стороны пары должны
      // вести себя одинаково, иначе отменённая ошибка вернулась бы в отчёты.
      excludeFromStats: locked.excludeFromStats,
      reversalOfMovementId: locked.id,
    })
    .returning();
  const reversalAllocations = undoingIncoming
    ? [{ receiptMovementId: locked.id, quantity: locked.quantity }]
    : allocations.map((allocation) => ({
        receiptMovementId: allocation.receiptMovementId,
        quantity: allocation.quantity,
      }));
  await tx.insert(movementBatchAllocationsTable).values(
    reversalAllocations.map((allocation) => ({
      movementId: reversal.id,
      ...allocation,
    })),
  );
  await recalculateProductFromBatches(tx, locked.productId);
  if (undoingIncoming) {
    const purchasePrice = locked.previousPurchasePrice ?? locked.unitPrice;
    const markupPercent = locked.previousMarkupPercent ?? 0;
    const [product] = await tx
      .select({ averagePrice: productsTable.averagePrice })
      .from(productsTable)
      .where(eq(productsTable.id, locked.productId));
    await tx
      .update(productsTable)
      .set({
        purchasePrice,
        markupPercent,
        salePrice: salePrice(product?.averagePrice ?? 0, markupPercent),
      })
      .where(eq(productsTable.id, locked.productId));
  }
  return { original: locked, reversal };
}

/**
 * Отмена любой складской операции из истории.
 *
 * Использует ту же проверенную логику, что и отмена операции ассистента:
 * защита от повторной отмены, от отмены прихода с уже израсходованной партией
 * и от отмены, если после неё были движения этого товара. Разница только в том,
 * что здесь не требуется, чтобы операция была последней у ассистента.
 */
router.post("/movements/:id/undo", async (req, res): Promise<void> => {
  const params = UndoMovementParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Неверный идентификатор операции" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [operation] = await tx
        .select()
        .from(movementsTable)
        .where(eq(movementsTable.id, params.data.id));
      if (!operation) throw new Error("Операция не найдена");
      if (operation.reversalOfMovementId !== null) {
        const error = new Error("Это компенсирующая запись, её нельзя отменить");
        error.name = "AlreadyUndone";
        throw error;
      }
      const { original, reversal } = await buildUndoReversal(tx, operation, {
        protectBatch: null,
      });
      return { original, reversal };
    });
    // Единицу берём у товара: без неё уведомление «отменено: 2 ед.» не говорит,
    // чего именно два — стеблей, штук или упаковок.
    const [product] = await db
      .select({ unit: productsTable.unit })
      .from(productsTable)
      .where(eq(productsTable.id, result.original.productId));
    const unit = product?.unit ?? "ед.";
    res.json(
      UndoMovementResponse.parse({
        movementId: result.original.id,
        reversalId: result.reversal.id,
        productName: result.original.productName,
        quantity: result.original.quantity,
        answer: `Операция отменена: ${result.original.productName}, ${result.original.quantity} ${unit}. Остатки партий восстановлены.`,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось отменить операцию";
    const notFound = message === "Операция не найдена";
    res.status(notFound ? 404 : 400).json({ error: message });
  }
});

router.post("/assistant/operations/:movementId/undo", async (req, res): Promise<void> => {
  const params = UndoAssistantOperationParams.safeParse(req.params);
  const body = UndoAssistantOperationBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Неверные данные отмены" });
    return;
  }
  const [assistantMessage] = await db
    .select({ id: assistantMessagesTable.id })
    .from(assistantMessagesTable)
    .where(
      and(
        eq(assistantMessagesTable.conversationId, body.data.conversationId),
        eq(assistantMessagesTable.movementId, params.data.movementId),
        eq(assistantMessagesTable.role, "assistant"),
      ),
    );
  if (!assistantMessage) {
    res.status(404).json({ error: "Операция ассистента не найдена в этом диалоге" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [operationReference] = await tx
        .select()
        .from(movementsTable)
        .where(eq(movementsTable.id, params.data.movementId));
      if (!operationReference) throw new Error("Операция не найдена");
      const [latestAssistantOperation] = await tx
        .select({ movementId: assistantMessagesTable.movementId })
        .from(assistantMessagesTable)
        .where(
          and(
            eq(assistantMessagesTable.conversationId, body.data.conversationId),
            sql`${assistantMessagesTable.movementId} is not null`,
          ),
        )
        .orderBy(desc(assistantMessagesTable.id))
        .limit(1);
      // An invoice writes one receipt per line, so "only the newest operation"
      // would make every line but the last one un-revertible. Lines belonging to
      // an invoice confirmation may be reverted individually; the later-movement
      // check below still protects the product's history.
      const [invoiceLine] = await tx
        .select({ id: assistantMessagesTable.id })
        .from(assistantMessagesTable)
        .where(
          and(
            eq(assistantMessagesTable.movementId, operationReference.id),
            eq(assistantMessagesTable.action, "invoice_receipt_created"),
          ),
        )
        .limit(1);
      const { original, reversal } = await buildUndoReversal(tx, operationReference, {
        protectBatch: null,
      });
      if (latestAssistantOperation?.movementId !== original.id && !invoiceLine) {
        throw new Error("Можно отменить только последнюю операцию ассистента");
      }
      const answer = `Операция отменена: ${original.productName}, ${original.quantity} ед. Остатки партий восстановлены.`;
      await tx.insert(assistantMessagesTable).values({
        conversationId: body.data.conversationId,
        role: "assistant",
        content: answer,
        action: "operation_undone",
      });
      return { original, reversal, answer };
    });
    res.json(UndoAssistantOperationResponse.parse({
      answer: result.answer,
      action: "operation_undone",
      operationId: null,
      canUndo: false,
      suggestions: ["Покажи остатки", "Покажи последние операции"],
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось отменить операцию";
    const databaseCode =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "";
    res.status(
      error instanceof Error && error.name === "AlreadyUndone" || databaseCode === "23505"
        ? 409
        : 400,
    ).json({
      error: message,
    });
  }
});

/**
 * Отменяет весь набор операций одной команды ассистента.
 *
 * Composite commands write several movements under one batch id; reverting them
 * one by one is both tedious and fragile (a later line of the same batch would
 * block an earlier one), so the whole set is reversed in a single transaction.
 */
router.post("/assistant/batches/:batchId/undo", async (req, res): Promise<void> => {
  const params = UndoAssistantBatchParams.safeParse(req.params);
  const body = UndoAssistantBatchBody.safeParse(req.body ?? {});
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Неверный идентификатор набора операций" });
    return;
  }
  const { batchId } = params.data;
  try {
    const result = await db.transaction(async (tx) => {
      const batchMovements = await tx
        .select()
        .from(movementsTable)
        .where(eq(movementsTable.assistantBatchId, batchId))
        .orderBy(asc(movementsTable.id));
      if (!batchMovements.length) {
        const error = new Error("Набор операций ассистента не найден");
        error.name = "BatchNotFound";
        throw error;
      }
      const movedIds = batchMovements.map((movement) => movement.id);
      // Сообщение об отмене пишется в тот же диалог, где прошёл набор: тело
      // запроса может не указывать диалог, а внешнего ключа на несуществующий
      // диалог у таблицы сообщений нет.
      const conversationId =
        body.data.conversationId ??
        (
          await tx
            .select({ conversationId: assistantMessagesTable.conversationId })
            .from(assistantMessagesTable)
            .where(inArray(assistantMessagesTable.movementId, movedIds))
            .orderBy(desc(assistantMessagesTable.id))
            .limit(1)
        )[0]?.conversationId ??
        null;
      const reversals = await tx
        .select({ reversalOfMovementId: movementsTable.reversalOfMovementId })
        .from(movementsTable)
        .where(inArray(movementsTable.reversalOfMovementId, movedIds));
      const reversedIds = new Set(reversals.map((row) => row.reversalOfMovementId));
      const pending = batchMovements.filter((movement) => !reversedIds.has(movement.id));
      if (!pending.length) {
        const error = new Error("Все операции набора уже отменены");
        error.name = "AlreadyUndone";
        throw error;
      }
      const undone: Array<{ productName: string; quantity: number }> = [];
      for (const movement of pending) {
        const { original } = await buildUndoReversal(tx, movement, {
          protectBatch: batchId,
        });
        undone.push({ productName: original.productName, quantity: original.quantity });
      }
      const positions = undone
        .map((item) => `«${item.productName}» — ${item.quantity} ед.`)
        .join(", ");
      const answer =
        `Набор операций отменён: ${undone.length} из ${batchMovements.length}. ` +
        `${positions}. Остатки партий восстановлены.`;
      if (conversationId) {
        await tx.insert(assistantMessagesTable).values({
          conversationId,
          role: "assistant",
          content: answer,
          action: "batch_undone",
        });
      }
      return { answer, undoneCount: undone.length, total: batchMovements.length };
    });
    res.json(UndoAssistantBatchResponse.parse({
      answer: result.answer,
      action: "batch_undone",
      operationId: null,
      canUndo: false,
      suggestions: ["Покажи остатки", "Покажи последние операции"],
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось отменить набор";
    const name = error instanceof Error ? error.name : "";
    res
      .status(name === "BatchNotFound" ? 404 : name === "AlreadyUndone" ? 409 : 400)
      .json({ error: message });
  }
});

/**
 * Dependencies the shared assistant service needs from this layer.
 *
 * Живут в `lib/assistant-dependencies`, чтобы боты пользовались тем же набором
 * операций, что и веб-интерфейс.
 */
import { createAssistantDependencies } from "../lib/assistant-dependencies";
export const assistantDependencies = createAssistantDependencies;

/**
 * Разбирает команду и записывает её в диалог.
 *
 * Составная команда (несколько позиций) или команда со спорной позицией не
 * проводится: пользователь видит разбор и подтверждает его отдельным запросом.
 * Одиночная однозначная команда работает как раньше — проводится сразу.
 */
router.post("/assistant/command", async (req, res): Promise<void> => {
  const parsed = RunAssistantCommandBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await planAssistantCommand(
      {
        conversationId: parsed.data.conversationId,
        message: parsed.data.message,
        authorId: req.user?.id ?? null,
      },
      assistantDependencies(req.user?.id ?? null),
    );
    res.json(RunAssistantCommandResponse.parse(result));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Ассистент не смог выполнить команду",
    });
  }
});

/** Проводит подтверждённый разбор команды одним набором операций. */
router.post("/assistant/command/apply", async (req, res): Promise<void> => {
  const parsed = ApplyAssistantCommandPlanBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const result = await applyAssistantPlan(
      {
        conversationId: parsed.data.conversationId,
        plan: parsed.data.plan,
      },
      assistantDependencies(req.user?.id ?? null),
    );
    res.json(ApplyAssistantCommandPlanResponse.parse(result));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось провести план ассистента",
    });
  }
});

export default router;