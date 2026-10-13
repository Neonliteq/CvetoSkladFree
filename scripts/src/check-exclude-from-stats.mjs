/**
 * Проверяет операции, помеченные «не учитывать в статистике».
 *
 * Смысл пометки: остаток меняется, история операцию показывает, а отчёты её не
 * считают. Поэтому проверка сверяет и склад, и аналитику — по отдельности каждое
 * из этих утверждений выглядит правдоподобно даже при поломке.
 *
 * Usage: node scripts/src/check-exclude-from-stats.mjs
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
    parsed = text;
  }
  return { status: response.status, body: parsed };
};

const products = (await call("GET", "/api/products")).body ?? [];
const analytics = () => call("GET", "/api/analytics/movements").then((r) => r.body);
const movements = () => call("GET", "/api/movements?limit=100").then((r) => r.body ?? []);

const product = products.find(
  (item) => item.productType === "stock" && item.currentStock >= 10,
);
const stockOf = async (id) =>
  ((await call("GET", "/api/products")).body ?? []).find((item) => item.id === id)?.currentStock;

console.log("=== 1. Списание вне статистики ===");
const before = await analytics();
const stockBefore = await stockOf(product.id);
const writeoff = await call("POST", "/api/movements", {
  productId: product.id,
  type: "writeoff",
  quantity: 3,
  reason: "Проверка: списание без учёта",
  excludeFromStats: true,
});
record(
  "списание с пометкой проведено",
  writeoff.status === 201 && writeoff.body?.excludeFromStats === true,
  `статус ${writeoff.status}, пометка ${writeoff.body?.excludeFromStats}`,
);

const stockAfter = await stockOf(product.id);
record(
  "остаток всё равно уменьшился",
  Math.round((stockBefore - stockAfter) * 100) / 100 === 3,
  `было ${stockBefore}, стало ${stockAfter}`,
);

const after = await analytics();
record(
  "число операций в аналитике не изменилось",
  after?.totalOperations === before?.totalOperations,
  `${before?.totalOperations} → ${after?.totalOperations}`,
);
record(
  "себестоимость в аналитике не изменилась",
  after?.totalCost === before?.totalCost,
  `${before?.totalCost} → ${after?.totalCost}`,
);
record(
  "выручка и прибыль не изменились",
  after?.totalRevenue === before?.totalRevenue && after?.grossProfit === before?.grossProfit,
  `${before?.totalRevenue}/${before?.grossProfit} → ${after?.totalRevenue}/${after?.grossProfit}`,
);
const writeoffType = (after?.byType ?? []).find((item) => item.type === "writeoff");
const writeoffBefore = (before?.byType ?? []).find((item) => item.type === "writeoff");
record(
  "в разрезе по типам списание не прибавилось",
  (writeoffType?.quantity ?? 0) === (writeoffBefore?.quantity ?? 0) &&
    (writeoffType?.operations ?? 0) === (writeoffBefore?.operations ?? 0),
  JSON.stringify({ before: writeoffBefore, after: writeoffType }),
);
record(
  "в динамике по дням сумм не прибавилось",
  (after?.timeline ?? []).reduce((sum, item) => sum + item.value, 0) ===
    (before?.timeline ?? []).reduce((sum, item) => sum + item.value, 0),
  `${(before?.timeline ?? []).reduce((sum, item) => sum + item.value, 0)} → ${(after?.timeline ?? []).reduce((sum, item) => sum + item.value, 0)}`,
);

console.log("\n=== 2. Операция видна в истории с пометкой ===");
const history = await movements();
const found = history.find((item) => item.id === writeoff.body?.id);
record("операция есть в истории", Boolean(found), `id ${writeoff.body?.id}`);
record(
  "в истории стоит пометка «не в статистике»",
  found?.excludeFromStats === true,
  JSON.stringify({ excludeFromStats: found?.excludeFromStats, reason: found?.reason }),
);
record(
  "причина списания сохранилась",
  found?.reason === "Проверка: списание без учёта",
  String(found?.reason),
);

console.log("\n=== 3. Отмена исключённой операции ===");
// Отменяем сразу: сервер запрещает отмену, если после операции были другие
// движения этого товара — а дальше по проверке они будут.
const undo = await call("POST", `/api/movements/${writeoff.body?.id}/undo`, {});
record(
  "исключённое списание отменено",
  undo.status === 200,
  `статус ${undo.status}, ${JSON.stringify(undo.body)?.slice(0, 120)}`,
);
const afterUndo = await analytics();
record(
  "после отмены аналитика не изменилась",
  afterUndo?.totalOperations === after?.totalOperations &&
    afterUndo?.totalCost === after?.totalCost,
  `операций ${after?.totalOperations} → ${afterUndo?.totalOperations}, себестоимость ${after?.totalCost} → ${afterUndo?.totalCost}`,
);
const restoredStock = await stockOf(product.id);
record(
  "остаток вернулся",
  Math.round((restoredStock - stockBefore) * 100) / 100 === 0,
  `до проверки ${stockBefore}, сейчас ${restoredStock}`,
);

const history2 = await movements();
const reversal = history2.find((item) => item.reversalOfMovementId === writeoff.body?.id);
record(
  "компенсирующая операция тоже помечена",
  reversal?.excludeFromStats === true,
  JSON.stringify({ id: reversal?.id, excludeFromStats: reversal?.excludeFromStats }),
);

console.log("\n=== 4. Обычное списание по-прежнему считается ===");
const counted = await call("POST", "/api/movements", {
  productId: product.id,
  type: "writeoff",
  quantity: 2,
  reason: "Проверка: обычное списание",
});
record(
  "списание без пометки проведено",
  counted.status === 201 && counted.body?.excludeFromStats === false,
  `статус ${counted.status}, пометка ${counted.body?.excludeFromStats}`,
);
const withCounted = await analytics();
record(
  "обычное списание в аналитику попало",
  withCounted?.totalOperations === (afterUndo?.totalOperations ?? 0) + 1,
  `${afterUndo?.totalOperations} → ${withCounted?.totalOperations}`,
);
const countedType = (withCounted?.byType ?? []).find((item) => item.type === "writeoff");
record(
  "количество в разрезе выросло на 2",
  Math.round(((countedType?.quantity ?? 0) - (writeoffType?.quantity ?? 0)) * 100) / 100 === 2,
  `${writeoffType?.quantity} → ${countedType?.quantity}`,
);

console.log("\n=== 5. Приход по ошибке тоже можно исключить ===");
const receipt = await call("POST", "/api/movements", {
  productId: product.id,
  type: "receipt",
  quantity: 5,
  unitPrice: 100,
  reason: "Проверка: приход по ошибке",
  excludeFromStats: true,
});
record(
  "приход с пометкой проведён",
  receipt.status === 201 && receipt.body?.excludeFromStats === true,
  `статус ${receipt.status}, пометка ${receipt.body?.excludeFromStats}`,
);
const afterReceipt = await analytics();
record(
  "приход вне статистики аналитику не изменил",
  afterReceipt?.totalOperations === withCounted?.totalOperations &&
    afterReceipt?.totalValue === withCounted?.totalValue,
  `операций ${withCounted?.totalOperations} → ${afterReceipt?.totalOperations}, стоимость ${withCounted?.totalValue} → ${afterReceipt?.totalValue}`,
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
