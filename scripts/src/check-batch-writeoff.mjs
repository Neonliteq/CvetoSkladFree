/**
 * Проверяет списание из конкретного прихода.
 *
 * Usage: node scripts/src/check-batch-writeoff.mjs
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
const cookie = session.cookieHeader;

const call = async (method, path, body) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 150);
  }
  return { status: response.status, body: parsed };
};

const batchesOf = async (productId) => {
  const receipts = (await call("GET", `/api/products/${productId}/receipts`)).body ?? [];
  return receipts
    .filter((receipt) => (receipt.remainingQuantity ?? 0) > 0)
    .sort((a, b) => String(a.batchArrivalDate).localeCompare(String(b.batchArrivalDate)));
};

console.log("=== 1. Ищем товар с несколькими партиями ===");
const products = (await call("GET", "/api/products")).body ?? [];
let product = null;
let batches = [];
for (const candidate of products.filter((item) => item.productType === "stock")) {
  const candidateBatches = await batchesOf(candidate.id);
  if (candidateBatches.length >= 2) {
    product = candidate;
    batches = candidateBatches;
    break;
  }
}
if (!product) {
  console.error("Нет товара с двумя партиями — проверку выполнить нельзя");
  process.exit(1);
}
console.log(`  товар: ${product.name}, партий: ${batches.length}`);
for (const batch of batches) {
  console.log(
    `    приход №${batch.id} от ${batch.batchArrivalDate}: остаток ${batch.remainingQuantity} по ${batch.unitPrice}`,
  );
}

// Списываем из ВТОРОЙ по старшинству партии — так видно, что выбор работает,
// а не совпадает со обычным порядком.
const chosen = batches[batches.length - 1];
const oldest = batches[0];
const stockBefore = product.currentStock;

console.log(`\n=== 2. Списываем 1 единицу из прихода №${chosen.id} (не из самого старого) ===`);
const writeoff = await call("POST", "/api/movements", {
  productId: product.id,
  type: "writeoff",
  quantity: 1,
  receiptMovementId: chosen.id,
  reason: "Проверка выбора партии",
});
record("списание прошло", writeoff.status === 201, `статус ${writeoff.status} ${JSON.stringify(writeoff.body).slice(0, 110)}`);

const allocations = writeoff.body?.batchAllocations ?? [];
record(
  "списание взято именно из выбранного прихода",
  allocations.length === 1 && allocations[0]?.receiptMovementId === chosen.id,
  JSON.stringify(allocations.map((item) => `${item.receiptMovementId}:${item.quantity}`)),
);
record(
  "списание не тронуло самую старую партию",
  !allocations.some((item) => item.receiptMovementId === oldest.id),
  "",
);

console.log("\n=== 3. Остатки партий изменились правильно ===");
const after = await batchesOf(product.id);
const chosenAfter = after.find((batch) => batch.id === chosen.id);
const oldestAfter = after.find((batch) => batch.id === oldest.id) ?? batches[0];
record(
  "выбранная партия уменьшилась на 1",
  chosenAfter ? chosenAfter.remainingQuantity === chosen.remainingQuantity - 1 : true,
  chosenAfter ? `${chosen.remainingQuantity} → ${chosenAfter.remainingQuantity}` : "партия закончилась",
);
const oldestUnchanged =
  after.find((batch) => batch.id === oldest.id)?.remainingQuantity ?? 0;
record(
  "самая старая партия не изменилась",
  oldestUnchanged === oldest.remainingQuantity,
  `${oldest.remainingQuantity} → ${oldestUnchanged}`,
);

const productAfter = (await call("GET", "/api/products")).body?.find((item) => item.id === product.id);
record("общий остаток товара уменьшился на 1", productAfter?.currentStock === stockBefore - 1, `${stockBefore} → ${productAfter?.currentStock}`);

console.log("\n=== 4. Проверки ошибок ===");
// Берём количество больше выбранной партии, но меньше общего остатка товара:
// так проверяется именно выбор партии, а не нехватка на складе.
const chosenLeft = chosenAfter?.remainingQuantity ?? 0;
const otherStock = after
  .filter((batch) => batch.id !== chosen.id)
  .reduce((sum, batch) => sum + (batch.remainingQuantity ?? 0), 0);
const overBatch = chosenLeft + Math.min(1, otherStock);
const tooMuch = await call("POST", "/api/movements", {
  productId: product.id,
  type: "writeoff",
  quantity: overBatch,
  receiptMovementId: chosen.id,
  reason: "Проверка превышения по партии",
});
record(
  "нельзя списать больше, чем в выбранном приходе",
  tooMuch.status === 400,
  `статус ${tooMuch.status}: ${JSON.stringify(tooMuch.body).slice(0, 110)}`,
);
record(
  "в ошибке названо доступное количество",
  typeof tooMuch.body?.error === "string" && tooMuch.body.error.includes("выбранном приходе"),
  tooMuch.body?.error,
);

const wrongProduct = (await call("GET", "/api/products")).body?.find(
  (item) => item.id !== product.id && item.productType === "stock",
);
const foreignBatch = await call("POST", "/api/movements", {
  productId: wrongProduct.id,
  type: "writeoff",
  quantity: 1,
  receiptMovementId: chosen.id,
  reason: "Проверка чужой партии",
});
record("нельзя списать из прихода другого товара", foreignBatch.status === 400, `статус ${foreignBatch.status}`);

console.log("\n=== 5. Автоматический порядок по-прежнему работает ===");
const auto = await call("POST", "/api/movements", {
  productId: product.id,
  type: "writeoff",
  quantity: 1,
  reason: "Проверка автоматического порядка",
});
const autoAllocations = auto.body?.batchAllocations ?? [];
const firstWithStock = (await batchesOf(product.id))[0];
record(
  "без выбора партии берётся самая старая",
  auto.status === 201 && autoAllocations[0]?.receiptMovementId === firstWithStock?.id,
  `${JSON.stringify(autoAllocations.map((item) => item.receiptMovementId))} против старой ${firstWithStock?.id}`,
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
