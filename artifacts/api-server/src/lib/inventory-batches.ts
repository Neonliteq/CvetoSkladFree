import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { movementsTable, productsTable } from "@workspace/db";

type Transaction = any;

async function initializeLegacyBatches(tx: Transaction, productId: number) {
  const [uninitialized] = await tx
    .select({ id: movementsTable.id })
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.productId, productId),
        inArray(movementsTable.type, ["receipt", "production_output"]),
        isNull(movementsTable.remainingQuantity),
      ),
    )
    .limit(1);
  if (!uninitialized) return;

  const [product] = await tx
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, productId))
    .for("update");
  if (!product) throw new Error("Товар не найден");

  const incomingMovements = await tx
    .select()
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.productId, productId),
        inArray(movementsTable.type, ["receipt", "production_output"]),
      ),
    )
    .orderBy(
      asc(movementsTable.batchArrivalDate),
      asc(movementsTable.createdAt),
      asc(movementsTable.id),
    );

  let stockToAllocate = product.currentStock;
  for (const incomingMovement of [...incomingMovements].reverse()) {
    const remaining = Math.min(incomingMovement.quantity, Math.max(0, stockToAllocate));
    await tx
      .update(movementsTable)
      .set({ remainingQuantity: remaining })
      .where(eq(movementsTable.id, incomingMovement.id));
    stockToAllocate -= remaining;
  }
  if (stockToAllocate > 0) {
    await tx.insert(movementsTable).values({
      productId,
      productName: product.name,
      type: "receipt",
      quantity: stockToAllocate,
      remainingQuantity: stockToAllocate,
      unitPrice: product.averagePrice,
      reason: "Начальный остаток до учёта партий",
      batchArrivalDate: product.createdAt.toISOString().slice(0, 10),
    });
  }
}

/**
 * Consumes stock from batches.
 *
 * By default the oldest batch goes first (FIFO), which is what a flower shop
 * wants for freshness. When `options.fromReceiptId` is given, that batch is
 * consumed first — the shopkeeper may know the write-off came from a specific
 * delivery. Any quantity the chosen batch cannot cover falls back to FIFO, so a
 * slightly short batch does not fail the whole operation.
 */
export async function consumeBatchesFifo(
  tx: Transaction,
  productId: number,
  quantity: number,
  options?: { fromReceiptId?: number | null; fromProductionBatchId?: string | null },
) {
  await initializeLegacyBatches(tx, productId);
  const batchRows = await tx
    .select({
      id: movementsTable.id,
      remainingQuantity: movementsTable.remainingQuantity,
      unitPrice: movementsTable.unitPrice,
      productionBatchId: movementsTable.productionBatchId,
    })
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.productId, productId),
        inArray(movementsTable.type, ["receipt", "production_output"]),
        sql`${movementsTable.remainingQuantity} > 0`,
      ),
    )
    .orderBy(
      asc(movementsTable.batchArrivalDate),
      asc(movementsTable.createdAt),
      asc(movementsTable.id),
    )
    .for("update");

  const batches: Array<{
    id: number;
    remainingQuantity: number | null;
    unitPrice: number;
    productionBatchId: string | null;
  }> = batchRows;

  const fromReceiptId = options?.fromReceiptId ?? null;
  const fromProductionBatchId = options?.fromProductionBatchId ?? null;
  if (fromReceiptId !== null && fromProductionBatchId !== null) {
    throw new Error("Укажите либо приход, либо сборку — не оба сразу");
  }
  if (fromProductionBatchId !== null) {
    // Сборка букета — это тоже партия: её выпуск лежит среди партий товара,
    // и продать букет можно именно из неё.
    const requested = batches.find(
      (batch) => batch.productionBatchId === fromProductionBatchId,
    );
    if (!requested) {
      throw new Error("В этой сборке не осталось букетов");
    }
    const available = requested.remainingQuantity ?? 0;
    if (available < quantity) {
      throw new Error(
        `В выбранной сборке только ${available} из ${quantity}. Уменьшите количество или выберите другую сборку.`,
      );
    }
    batches.splice(batches.indexOf(requested), 1);
    batches.unshift(requested);
  }
  if (fromReceiptId !== null) {
    const requested = batches.find((batch) => batch.id === fromReceiptId);
    if (!requested) {
      // Either the batch belongs to another product, or nothing is left in it.
      throw new Error("В выбранном приходе нет остатка этого товара");
    }
    const available = requested.remainingQuantity ?? 0;
    if (available < quantity) {
      throw new Error(
        `В выбранном приходе только ${available} из ${quantity}. Уменьшите количество или выберите другой приход.`,
      );
    }
    // Move the chosen batch to the front, keeping the rest in FIFO order.
    batches.splice(batches.indexOf(requested), 1);
    batches.unshift(requested);
  }

  let amountLeft = quantity;
  const allocations: Array<{
    receiptMovementId: number;
    quantity: number;
    unitPrice: number;
  }> = [];
  for (const batch of batches) {
    if (amountLeft <= 0) break;
    const consumed = Math.min(batch.remainingQuantity ?? 0, amountLeft);
    const [updated] = await tx
      .update(movementsTable)
      .set({ remainingQuantity: sql`${movementsTable.remainingQuantity} - ${consumed}` })
      .where(
        and(
          eq(movementsTable.id, batch.id),
          sql`${movementsTable.remainingQuantity} >= ${consumed}`,
        ),
      )
      .returning({ id: movementsTable.id });
    if (!updated) throw new Error("Остаток партии изменился, повторите операцию");
    allocations.push({
      receiptMovementId: batch.id,
      quantity: consumed,
      unitPrice: batch.unitPrice,
    });
    amountLeft -= consumed;
  }
  if (amountLeft > 0) {
    throw new Error("Недостаточно товара в партиях");
  }
  return allocations;
}

export async function ensureBatchBalances(tx: Transaction, productId: number) {
  await initializeLegacyBatches(tx, productId);
}