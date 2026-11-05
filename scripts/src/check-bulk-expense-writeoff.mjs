/**
 * Массовые продажа и списание: несколько товаров одним документом.
 *
 * Проверяет главное свойство — **документ либо проходит целиком, либо не проходит вовсе**.
 * Ошибка в последней строке не должна оставить в базе первые: иначе остатки разъедутся с
 * бумагой, а разбираться придётся вручную.
 *
 * Дополнительно проверяется то, что легко сломать незаметно: цена продажи по умолчанию
 * берётся по наценке товара, выручка и себестоимость считаются по-разному, своя причина
 * строки важнее общей, пометка «не в статистике» доходит до всех строк.
 *
 * Usage: node scripts/src/check-bulk-expense-writeoff.mjs
 */
import { seedDatabase } from "./seed-helper.mjs";
import { signIn } from "./auth-helper.mjs";

seedDatabase();

const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const session = await signIn(api);

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const call = async (method, route, body) => {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: {
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

const allProducts = async () => (await call("GET", "/api/products")).body ?? [];
const stockOf = async (productId) =>
  (await allProducts()).find((item) => item.id === productId)?.currentStock ?? null;

// Демо-данные: берём товары склада с запасом, чтобы продавать и списывать без нехватки.
let products = (await allProducts()).filter(
  (item) => item.productType === "stock" && item.currentStock >= 20,
);
if (products.length < 4) throw new Error("в демо-данных мало товаров с запасом для проверки");
products = products.slice(0, 4);
console.log(`товары для проверки: ${products.map((item) => item.name).join(", ")}`);

console.log("=== 1. Продажа нескольких товаров ===");
const before = new Map();
for (const product of products) before.set(product.id, await stockOf(product.id));

// Цену у первой строки задаём сами, у остальных не задаём вовсе: сервер обязан взять
// цену товара по наценке.
const salePrice = 111;
const sale = await call("POST", "/api/movements/bulk-expense", {
  positions: [
    { productId: products[0].id, quantity: 3, saleUnitPrice: salePrice },
    { productId: products[1].id, quantity: 5 },
    { productId: products[2].id, quantity: 2 },
  ],
  reason: "Проверка массовой продажи",
});
record("продажа прошла", sale.status === 201, `статус ${sale.status} ${JSON.stringify(sale.body)?.slice(0, 200)}`);
record(
  "создано три операции",
  sale.body?.movements?.length === 3,
  `операций: ${sale.body?.movements?.length}`,
);
record(
  "итоговое количество — сумма строк",
  sale.body?.totalQuantity === 10,
  `totalQuantity ${sale.body?.totalQuantity}`,
);
record(
  "выручка совпадает с суммой строк",
  (() => {
    const expected = sale.body?.movements?.reduce(
      (sum, movement) => sum + movement.quantity * (movement.saleUnitPrice ?? 0),
      0,
    );
    return Math.abs((sale.body?.totalRevenue ?? -1) - expected) < 0.01;
  })(),
  `totalRevenue ${sale.body?.totalRevenue}`,
);
record(
  "цена по умолчанию взята из товара, а не ноль",
  (sale.body?.movements?.[1]?.saleUnitPrice ?? 0) > 0,
  `цена второй строки ${sale.body?.movements?.[1]?.saleUnitPrice}`,
);
record(
  "заданная цена не перебита",
  sale.body?.movements?.[0]?.saleUnitPrice === salePrice,
  `цена первой строки ${sale.body?.movements?.[0]?.saleUnitPrice}`,
);
record(
  "у продажи нет выручки в totalCost",
  (sale.body?.totalCost ?? 0) > 0 && sale.body?.totalRevenue > sale.body?.totalCost,
  `себестоимость ${sale.body?.totalCost}, выручка ${sale.body?.totalRevenue}`,
);

const afterSale = new Map();
for (const product of products.slice(0, 3)) afterSale.set(product.id, await stockOf(product.id));
record(
  "остатки уменьшились ровно на количество",
  afterSale.get(products[0].id) === before.get(products[0].id) - 3 &&
    afterSale.get(products[1].id) === before.get(products[1].id) - 5 &&
    afterSale.get(products[2].id) === before.get(products[2].id) - 2,
  JSON.stringify({
    первый: `${before.get(products[0].id)} → ${afterSale.get(products[0].id)}`,
    второй: `${before.get(products[1].id)} → ${afterSale.get(products[1].id)}`,
    третий: `${before.get(products[2].id)} → ${afterSale.get(products[2].id)}`,
  }),
);
record(
  "четвёртый товар не тронут",
  (await stockOf(products[3].id)) === before.get(products[3].id),
  "остаток изменился у товара, которого не было в документе",
);

console.log("=== 2. Списание нескольких товаров ===");
const writeoffBefore = new Map();
for (const product of products.slice(0, 3)) writeoffBefore.set(product.id, await stockOf(product.id));

const writeoff = await call("POST", "/api/movements/bulk-writeoff", {
  positions: [
    { productId: products[0].id, quantity: 1 },
    { productId: products[1].id, quantity: 2, reason: "Брак" },
  ],
  reason: "Увядшие стебли",
});
record("списание прошло", writeoff.status === 201, `статус ${writeoff.status} ${JSON.stringify(writeoff.body)?.slice(0, 200)}`);
record(
  "общая причина дошла до строки без своей",
  writeoff.body?.movements?.[0]?.reason === "Увядшие стебли",
  `причина первой строки: ${writeoff.body?.movements?.[0]?.reason}`,
);
record(
  "своя причина строки важнее общей",
  writeoff.body?.movements?.[1]?.reason === "Брак",
  `причина второй строки: ${writeoff.body?.movements?.[1]?.reason}`,
);
record(
  "стоимость списания посчитана по партиям, а не NaN",
  Number.isFinite(writeoff.body?.totalCost) && writeoff.body?.totalCost > 0,
  `totalCost ${writeoff.body?.totalCost}`,
);
record(
  "у списания выручки нет",
  writeoff.body?.totalRevenue === null,
  `totalRevenue ${JSON.stringify(writeoff.body?.totalRevenue)}`,
);
record(
  "остатки уменьшились ровно на количество",
  (await stockOf(products[0].id)) === writeoffBefore.get(products[0].id) - 1 &&
    (await stockOf(products[1].id)) === writeoffBefore.get(products[1].id) - 2,
  JSON.stringify({
    первый: `${writeoffBefore.get(products[0].id)} → ${await stockOf(products[0].id)}`,
    второй: `${writeoffBefore.get(products[1].id)} → ${await stockOf(products[1].id)}`,
  }),
);

console.log("=== 3. Ошибка в последней строке не проводит ничего ===");
// Нехватка остатка — самая частая ошибка: товар есть, но не в таком количестве.
const tooMuch = (await stockOf(products[2].id)) + 1000;
const beforeFailure = new Map();
for (const product of products.slice(0, 3)) beforeFailure.set(product.id, await stockOf(product.id));

const rejected = await call("POST", "/api/movements/bulk-expense", {
  positions: [
    { productId: products[0].id, quantity: 1 },
    { productId: products[1].id, quantity: 1 },
    { productId: products[2].id, quantity: tooMuch },
  ],
});
record("документ отклонён", rejected.status === 400, `статус ${rejected.status}`);
record(
  "ошибка называет третью строку",
  /Строка 3/.test(String(rejected.body?.error)),
  String(rejected.body?.error),
);
const afterFailure = new Map();
for (const product of products.slice(0, 3)) afterFailure.set(product.id, await stockOf(product.id));
record(
  "первые две строки НЕ проведены, остатки не изменились",
  afterFailure.get(products[0].id) === beforeFailure.get(products[0].id) &&
    afterFailure.get(products[1].id) === beforeFailure.get(products[1].id),
  JSON.stringify({
    первый: `${beforeFailure.get(products[0].id)} → ${afterFailure.get(products[0].id)}`,
    второй: `${beforeFailure.get(products[1].id)} → ${afterFailure.get(products[1].id)}`,
  }),
);

const failedWriteoff = await call("POST", "/api/movements/bulk-writeoff", {
  positions: [
    { productId: products[0].id, quantity: 1 },
    { productId: products[2].id, quantity: tooMuch },
  ],
  reason: "Проверка отката",
});
record(
  "списание с ошибкой тоже не проводит ничего",
  failedWriteoff.status === 400 &&
    (await stockOf(products[0].id)) === beforeFailure.get(products[0].id),
  `статус ${failedWriteoff.status}, остаток ${await stockOf(products[0].id)}`,
);

console.log("=== 4. Проверки входа ===");
const emptyExpense = await call("POST", "/api/movements/bulk-expense", { positions: [] });
record("пустой документ отклонён", emptyExpense.status === 400, `статус ${emptyExpense.status}`);

const zeroQuantity = await call("POST", "/api/movements/bulk-expense", {
  positions: [{ productId: products[0].id, quantity: 0 }],
});
record("нулевое количество отклонено", zeroQuantity.status === 400, `статус ${zeroQuantity.status}`);

const negativePrice = await call("POST", "/api/movements/bulk-expense", {
  positions: [{ productId: products[0].id, quantity: 1, saleUnitPrice: -5 }],
});
record("отрицательная цена продажи отклонена", negativePrice.status === 400, `статус ${negativePrice.status}`);

const missingProduct = await call("POST", "/api/movements/bulk-writeoff", {
  positions: [{ productId: 999999, quantity: 1 }],
});
record("несуществующий товар отклонён", missingProduct.status === 400, `статус ${missingProduct.status}`);

const tooMany = await call("POST", "/api/movements/bulk-expense", {
  positions: Array.from({ length: 51 }, () => ({ productId: products[0].id, quantity: 1 })),
});
record("больше 50 строк отклонено", tooMany.status === 400, `статус ${tooMany.status}`);

console.log("=== 5. Пометка «не в статистике» доходит до всех строк ===");
const beforeStats = await stockOf(products[0].id);
const excluded = await call("POST", "/api/movements/bulk-writeoff", {
  positions: [
    { productId: products[0].id, quantity: 1 },
    { productId: products[1].id, quantity: 1 },
  ],
  reason: "Списание вне статистики",
  excludeFromStats: true,
});
record(
  "пометка стоит у каждой строки",
  excluded.status === 201 &&
    excluded.body?.movements?.every((movement) => movement.excludeFromStats === true),
  JSON.stringify(excluded.body?.movements?.map((movement) => movement.excludeFromStats)),
);
record(
  "остаток всё равно изменился",
  (await stockOf(products[0].id)) === beforeStats - 1,
  `${beforeStats} → ${await stockOf(products[0].id)}`,
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
