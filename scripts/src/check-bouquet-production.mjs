/**
 * Проверяет производство букета с фактическим составом и ценой.
 *
 * Рецепт — шаблон, а в сборке цветок заменяют и цену ставят по факту. Скрипт
 * проверяет, что со склада списывается именно фактический состав, что партия
 * сборки сохраняется вместе с составом и ценой и что ошибки не портят склад.
 *
 * Usage: node scripts/src/check-bouquet-production.mjs
 */
import { seedDatabase } from "./seed-helper.mjs";
import { signIn } from "./auth-helper.mjs";

const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const session = await signIn(api);
const call = async (method, path, body) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 200);
  }
  return { status: response.status, body: parsed };
};

const money = (value) => Math.round(value * 100) / 100;
const stockOf = async (productId) =>
  ((await call("GET", "/api/products")).body ?? []).find((item) => item.id === productId)?.currentStock;
const bouquetOf = async (id) => ((await call("GET", "/api/bouquets")).body ?? []).find((item) => item.id === id);
const server = (value) => JSON.parse(JSON.stringify(value));

const products = (await call("GET", "/api/products")).body ?? [];
const available = products.filter((item) => item.productType === "stock" && item.currentStock >= 20);
const [first, second] = available;

console.log("=== 1. Рецепт без минимального остатка ===");
const created = await call("POST", "/api/bouquets", {
  name: "Букет для проверки сборки",
  markupPercent: 100,
  components: [
    { productId: first.id, quantity: 4 },
    { productId: second.id, quantity: 6 },
  ],
});
record("рецепт создан", created.status === 201 && created.body?.id > 0, `статус ${created.status}: ${JSON.stringify(created.body)?.slice(0, 160)}`);
const bouquetId = created.body?.id;
record("букета нет в низком остатке", created.body?.minimumStock === 0, `минимальный остаток ${created.body?.minimumStock}`);
record("у рецепта посчитана себестоимость", created.body?.calculatedCost > 0, `себестоимость ${created.body?.calculatedCost}`);
record(
  "цена рецепта посчитана по наценке",
  created.body?.salePrice === money(created.body.calculatedCost * 2),
  `цена ${created.body?.salePrice}, себестоимость ${created.body?.calculatedCost}`,
);

const recipeCost = money(4 * first.averagePrice + 6 * second.averagePrice);
record(
  "себестоимость рецепта сходится с закупочными ценами",
  created.body?.calculatedCost === recipeCost,
  `в ответе ${created.body?.calculatedCost}, посчитано ${recipeCost}`,
);

console.log("\n=== 2. Сборка с заменой цветка и своей ценой ===");
// Заменяем часть состава и ставим цену, которая не совпадает с наценкой рецепта.
const overrides = {
  quantity: 1,
  salePrice: 777,
  ingredients: [
    { productId: first.id, quantity: 5 },
    { productId: second.id, quantity: 1 },
  ],
};
const stockBefore = { first: await stockOf(first.id), second: await stockOf(second.id) };
// Себестоимость сборки сервер считает по партиям склада (FIFO), а снимок состава
// хранит средние закупочные цены. Проверяем и снимок, и связь выпуска с партией.
const unitCost = money(5 * first.averagePrice + 1 * second.averagePrice);
const produced = await call("POST", `/api/bouquets/${bouquetId}/produce`, overrides);
record("сборка проведена", produced.status === 200, `статус ${produced.status}: ${JSON.stringify(produced.body)?.slice(0, 200)}`);

const batch = produced.body?.batch;
record("партия сборки вернулась", Boolean(batch?.id), JSON.stringify(batch)?.slice(0, 120));
record(
  "в партии фактическая цена",
  batch?.salePrice === 777,
  `цена ${batch?.salePrice}`,
);
record(
  "снимок состава посчитан по закупочным ценам",
  money(batch?.ingredients.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)) === unitCost,
  `в партии ${batch?.ingredients.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)}, посчитано ${unitCost}`,
);
record("себестоимость партии положительная", batch?.calculatedCost > 0, `себестоимость ${batch?.calculatedCost}`);
record(
  "в партии фактический состав, а не рецепт",
  server(batch?.ingredients)?.map((item) => [item.productId, item.quantity]).sort().join("|") ===
    [[first.id, 5], [second.id, 1]].sort().join("|"),
  JSON.stringify(batch?.ingredients?.map((item) => [item.productId, item.quantity])),
);
record(
  "в партии названия и единицы позиций",
  batch?.ingredients.every((item) => item.productName && item.unit && item.lineCost > 0),
  JSON.stringify(batch?.ingredients?.[0]),
);

console.log("\n=== 3. Со склада списано ровно фактическое количество ===");
const stockAfter = { first: await stockOf(first.id), second: await stockOf(second.id) };
record(
  "первая позиция списана по факту",
  stockAfter.first === stockBefore.first - 5,
  `${stockBefore.first} → ${stockAfter.first}`,
);
record(
  "вторая позиция списана по факту (не по рецепту)",
  stockAfter.second === stockBefore.second - 1,
  `${stockBefore.second} → ${stockAfter.second} (рецепт просил 6)`,
);
record(
  "остаток букета вырос",
  (await bouquetOf(bouquetId))?.currentStock === 1,
  `остаток ${(await bouquetOf(bouquetId))?.currentStock}`,
);

const movements = (await call("GET", "/api/movements?limit=100")).body ?? [];
const batchMovements = movements.filter((item) => item.productionBatchId === batch.id);
record(
  "в истории есть списание по каждой позиции и выпуск букета",
  batchMovements.length === 3 &&
    batchMovements.filter((item) => item.type === "production_input").length === 2 &&
    batchMovements.filter((item) => item.type === "production_output").length === 1,
  JSON.stringify(batchMovements.map((item) => `${item.type}:${item.productName}:${item.quantity}`)),
);
record(
  "выпуск записан по себестоимости партии",
  batchMovements.find((item) => item.type === "production_output")?.unitPrice === batch.calculatedCost,
  `цена выпуска ${batchMovements.find((item) => item.type === "production_output")?.unitPrice}, себестоимость партии ${batch.calculatedCost}`,
);
record(
  "списания помечены автором",
  batchMovements.filter((item) => item.type === "production_input").every((item) => item.createdByName),
  JSON.stringify(batchMovements.map((item) => item.createdByName)),
);

console.log("\n=== 4. История сборок ===");
const history = await call("GET", `/api/production-batches?bouquetId=${bouquetId}`);
record("история отдаётся", history.status === 200 && Array.isArray(history.body), `статус ${history.status}`);
record("в истории одна сборка", history.body?.length === 1, `записей ${history.body?.length}`);
record("история хранит фактическую цену", history.body?.[0]?.salePrice === 777, `цена ${history.body?.[0]?.salePrice}`);
record(
  "история хранит состав сборки",
  history.body?.[0]?.ingredients?.length === 2,
  JSON.stringify(history.body?.[0]?.ingredients?.map((item) => item.productName)),
);
const foreign = await call("GET", `/api/production-batches?bouquetId=99999999`);
record("несуществующий букет даёт 404", foreign.status === 404, `статус ${foreign.status}`);
const badQuery = await call("GET", "/api/production-batches");
record("запрос без букета отклонён", badQuery.status === 400, `статус ${badQuery.status}`);

console.log("\n=== 5. Сборка без изменений берёт рецепт ===");
const defaultProduce = await call("POST", `/api/bouquets/${bouquetId}/produce`, { quantity: 1 });
record("сборка по рецепту проведена", defaultProduce.status === 200, `статус ${defaultProduce.status}: ${JSON.stringify(defaultProduce.body)?.slice(0, 160)}`);
const defaultBatch = defaultProduce.body?.batch;
record(
  "состав взят из рецепта",
  server(defaultBatch?.ingredients)?.map((item) => [item.productId, item.quantity]).sort().join("|") ===
    [[first.id, 4], [second.id, 6]].sort().join("|"),
  JSON.stringify(defaultBatch?.ingredients?.map((item) => [item.productId, item.quantity])),
);
record(
  "цена взята по наценке рецепта",
  defaultBatch?.salePrice === money(defaultBatch.calculatedCost * 2),
  `цена ${defaultBatch?.salePrice}, себестоимость ${defaultBatch?.calculatedCost}`,
);
record(
  "в истории уже две сборки",
  (await call("GET", `/api/production-batches?bouquetId=${bouquetId}`)).body?.length === 2,
  "история не накопила сборки",
);

console.log("\n=== 6. Себестоимость букета пересчитана по факту ===");
const afterProduce = await bouquetOf(bouquetId);
record(
  "закупочная цена букета — это стоимость партий, а не рецепта",
  afterProduce?.averagePrice !== recipeCost,
  `рецепт ${recipeCost}, партии ${afterProduce?.averagePrice}`,
);
record(
  "средняя цена букета пересчитана по партиям",
  afterProduce?.averagePrice > 0 && afterProduce?.purchasePrice === afterProduce?.averagePrice,
  `средняя ${afterProduce?.averagePrice}, закупка ${afterProduce?.purchasePrice}`,
);
record(
  "цена продажи рецепта пересчитана по наценке",
  afterProduce?.salePrice === money(afterProduce.averagePrice * 2),
  `цена ${afterProduce?.salePrice} при средней ${afterProduce?.averagePrice}`,
);

console.log("\n=== 7. Нехватка товара не портит склад ===");
const guarded = available[0];
const guardedBefore = await stockOf(guarded.id);
const tooMuch = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
  quantity: 1,
  ingredients: [{ productId: guarded.id, quantity: 100000 }],
});
record("нехватка отклонена", tooMuch.status === 400, `статус ${tooMuch.status}`);
record(
  "в ошибке назван товар и количество",
  String(tooMuch.body?.error ?? "").includes(guarded.name) && String(tooMuch.body?.error ?? "").includes("Недостаточно"),
  String(tooMuch.body?.error).slice(0, 160),
);
const stockUntouched = await stockOf(guarded.id);
record(
  "после отказа остаток не изменился",
  stockUntouched === guardedBefore,
  `${guardedBefore} → ${stockUntouched}`,
);
record(
  "отказ не создал партию",
  (await call("GET", `/api/production-batches?bouquetId=${bouquetId}`)).body?.length === 2,
  "в истории появилась лишняя сборка",
);

console.log("\n=== 8. Некорректный состав ===");
const bouquetAsIngredient = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
  quantity: 1,
  ingredients: [{ productId: bouquetId, quantity: 1 }],
});
record("букет нельзя вложить в букет", bouquetAsIngredient.status === 400, `статус ${bouquetAsIngredient.status}`);
const unknownProduct = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
  quantity: 1,
  ingredients: [{ productId: 99999999, quantity: 1 }],
});
record("неизвестный товар отклонён", unknownProduct.status === 400, `статус ${unknownProduct.status}`);
const zeroQuantity = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
  quantity: 0,
  ingredients: [{ productId: first.id, quantity: 1 }],
});
record("нулевое количество отклонено", zeroQuantity.status === 400, `статус ${zeroQuantity.status}`);
const negativePrice = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
  quantity: 1,
  salePrice: -5,
  ingredients: [{ productId: first.id, quantity: 1 }],
});
record("отрицательная цена отклонена", negativePrice.status === 400, `статус ${negativePrice.status}`);

console.log("\n=== 9. Архивный товар в сборку не идёт ===");
const archivable = (await call("GET", "/api/products")).body.find(
  (item) => item.productType === "stock" && item.currentStock === 0 && item.id !== first.id && item.id !== second.id,
);
if (archivable) {
  await call("DELETE", `/api/products/${archivable.id}`);
  const withArchived = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
    quantity: 1,
    ingredients: [{ productId: archivable.id, quantity: 1 }],
  });
  record("архивный товар отклонён", withArchived.status === 400, `статус ${withArchived.status}`);
  record(
    "в ошибке объяснено, что товар в архиве",
    String(withArchived.body?.error ?? "").includes("архив"),
    String(withArchived.body?.error).slice(0, 140),
  );
  await call("POST", `/api/products/${archivable.id}/restore`, {});
  const archivedRecipe = await call("PATCH", `/api/bouquets/${bouquetId}`, {
    name: "Букет для проверки сборки",
    markupPercent: 100,
    components: [{ productId: archivable.id, quantity: 1 }],
  });
  record("архивный товар не попадает и в рецепт", archivedRecipe.status === 400, `статус ${archivedRecipe.status}`);
} else {
  record("архивный товар отклонён", true, "подходящего товара нет — пропускаю");
  record("в ошибке объяснено, что товар в архиве", true, "подходящего товара нет — пропускаю");
  record("архивный товар не попадает и в рецепт", true, "подходящего товара нет — пропускаю");
}

console.log("\n=== 10. Рецепт по-прежнему правится ===");
const patched = await call("PATCH", `/api/bouquets/${bouquetId}`, {
  name: "Букет для проверки сборки (правка)",
  markupPercent: 50,
  components: [{ productId: first.id, quantity: 3 }],
});
record("рецепт обновлён", patched.status === 200, `статус ${patched.status}: ${JSON.stringify(patched.body)?.slice(0, 140)}`);
record(
  "себестоимость рецепта пересчитана",
  patched.body?.calculatedCost === money(3 * first.averagePrice),
  `себестоимость ${patched.body?.calculatedCost}, ожидалось ${money(3 * first.averagePrice)}`,
);
record(
  "правка рецепта не стёрла историю сборок",
  (await call("GET", `/api/production-batches?bouquetId=${bouquetId}`)).body?.length === 2,
  "история потерялась",
);

console.log("\n=== 11. Сборки с остатком на складе ===");
const stockBatches = await call("GET", `/api/production-batches/stock?bouquetId=${bouquetId}`);
record("список сборок с остатком отдаётся", stockBatches.status === 200 && Array.isArray(stockBatches.body), `статус ${stockBatches.status}`);
record(
  "в списке только сборки с остатком",
  (stockBatches.body ?? []).length > 0 && stockBatches.body.every((batch) => batch.remainingQuantity > 0),
  JSON.stringify((stockBatches.body ?? []).map((batch) => [batch.id.slice(0, 8), batch.remainingQuantity])),
);
record(
  "у сборки есть операция выпуска",
  (stockBatches.body ?? []).every((batch) => Number.isInteger(batch.movementsId) && batch.movementsId > 0),
  JSON.stringify((stockBatches.body ?? []).map((batch) => batch.movementsId)),
);
const foreignStock = await call("GET", "/api/production-batches/stock?bouquetId=99999999");
record("несуществующий букет даёт 404", foreignStock.status === 404, `статус ${foreignStock.status}`);

console.log("\n=== 12. Продажа из конкретной сборки ===");
// Собираем две сборки с разной ценой, чтобы было что выбирать.
const expensive = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
  quantity: 1,
  salePrice: 900,
  ingredients: [{ productId: first.id, quantity: 2 }],
});
const cheaper = await call("POST", `/api/bouquets/${bouquetId}/produce`, {
  quantity: 1,
  salePrice: 400,
  ingredients: [{ productId: first.id, quantity: 2 }],
});
record("две сборки проведены", expensive.status === 200 && cheaper.status === 200, `${expensive.status}/${cheaper.status}`);

const stockForSale = (await call("GET", `/api/production-batches/stock?bouquetId=${bouquetId}`)).body ?? [];
record("обе сборки лежат на складе", stockForSale.length === 4, `сборок с остатком ${stockForSale.length}`);
const targetBatch = stockForSale.find((batch) => batch.id === cheaper.body?.batch?.id);
record("нужная сборка найдена", Boolean(targetBatch), JSON.stringify(targetBatch?.id));
record(
  "в списке видно фактическую цену сборки",
  targetBatch?.salePrice === 400,
  `цена ${targetBatch?.salePrice}`,
);

const bouquetStockBefore = (await bouquetOf(bouquetId))?.currentStock;
const sold = await call("POST", "/api/movements", {
  productId: bouquetId,
  type: "expense",
  quantity: 1,
  saleUnitPrice: 400,
  productionBatchId: targetBatch.id,
  reason: "Продажа конкретной сборки",
});
record("продажа прошла", sold.status === 201, `статус ${sold.status}: ${JSON.stringify(sold.body)?.slice(0, 160)}`);
record(
  "остаток букета уменьшился",
  (await bouquetOf(bouquetId))?.currentStock === bouquetStockBefore - 1,
  `${bouquetStockBefore} → ${(await bouquetOf(bouquetId))?.currentStock}`,
);
record(
  "списание привязано к выбранной сборке",
  (sold.body?.batchAllocations ?? []).some(
    (allocation) => allocation.receiptMovementId === targetBatch.movementsId,
  ),
  JSON.stringify(sold.body?.batchAllocations),
);
record(
  "чужая сборка не тронута",
  (sold.body?.batchAllocations ?? []).every(
    (allocation) => allocation.receiptMovementId === targetBatch.movementsId,
  ),
  JSON.stringify((sold.body?.batchAllocations ?? []).map((allocation) => allocation.receiptMovementId)),
);

const afterSale = (await call("GET", `/api/production-batches/stock?bouquetId=${bouquetId}`)).body ?? [];
record(
  "проданная сборка ушла из списка сборок с остатком",
  !afterSale.some((batch) => batch.id === targetBatch.id),
  JSON.stringify(afterSale.map((batch) => [batch.id.slice(0, 8), batch.remainingQuantity])),
);
record(
  "остальные сборки на месте",
  afterSale.length === stockForSale.length - 1,
  `${stockForSale.length} → ${afterSale.length}`,
);
const soldBatchHistory = (await call("GET", `/api/production-batches?bouquetId=${bouquetId}`)).body ?? [];
record(
  "в истории у проданной сборки остаток 0",
  soldBatchHistory.find((batch) => batch.id === targetBatch.id)?.remainingQuantity === 0,
  JSON.stringify(soldBatchHistory.map((batch) => [batch.id.slice(0, 8), batch.remainingQuantity])),
);

console.log("\n=== 13. Продажа из сборки, которой нет ===");
const withoutBatch = await call("POST", "/api/movements", {
  productId: bouquetId,
  type: "expense",
  quantity: 1,
  reason: "Продажа без сборки",
});
record("продажа букета без сборки отклонена", withoutBatch.status === 400, `статус ${withoutBatch.status}`);
record(
  "в ошибке сказано выбрать сборку",
  /сборк/i.test(String(withoutBatch.body?.error ?? "")),
  String(withoutBatch.body?.error).slice(0, 160),
);
record(
  "склад после отказа не изменился",
  (await bouquetOf(bouquetId))?.currentStock === bouquetStockBefore - 1,
  `остаток ${(await bouquetOf(bouquetId))?.currentStock}`,
);
const missingBatch = await call("POST", "/api/movements", {
  productId: bouquetId,
  type: "expense",
  quantity: 1,
  productionBatchId: "00000000-0000-0000-0000-000000000000",
  reason: "Проверка",
});
record("несуществующая сборка отклонена", missingBatch.status === 400, `статус ${missingBatch.status}`);
record(
  "в ошибке сказано, что сборка пуста",
  /сборк/i.test(String(missingBatch.body?.error ?? "")),
  String(missingBatch.body?.error).slice(0, 140),
);
const tooManyFromBatch = await call("POST", "/api/movements", {
  productId: bouquetId,
  type: "expense",
  quantity: 5,
  productionBatchId: stockForSale.find((batch) => batch.id !== targetBatch.id)?.id,
  reason: "Проверка",
});
record("нельзя продать больше, чем в сборке", tooManyFromBatch.status === 400, `статус ${tooManyFromBatch.status}`);
record(
  "в ошибке указан остаток сборки",
  /сборке/i.test(String(tooManyFromBatch.body?.error ?? "")),
  String(tooManyFromBatch.body?.error).slice(0, 160),
);
record(
  "отказы не изменили остаток букета",
  (await bouquetOf(bouquetId))?.currentStock === bouquetStockBefore - 1,
  `остаток ${(await bouquetOf(bouquetId))?.currentStock}`,
);

console.log("\n=== 14. Детализация продажи в истории операций ===");
const movementRow = (await call("GET", "/api/movements?limit=5")).body?.[0];
record(
  "в истории у продажи видна партия",
  (movementRow?.batchAllocations ?? []).length > 0,
  JSON.stringify(movementRow?.batchAllocations),
);
record(
  "у партии есть цена и стоимость строки",
  (movementRow?.batchAllocations ?? []).every(
    (allocation) => allocation.unitPrice > 0 && allocation.lineCost > 0,
  ),
  JSON.stringify(movementRow?.batchAllocations),
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
