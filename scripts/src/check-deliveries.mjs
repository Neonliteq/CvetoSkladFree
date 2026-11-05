/**
 * Список поставок и контроль приходов.
 *
 * Поставка — приход, проведённый в один момент одним человеком. Проверяется то, что легко
 * сломать незаметно: позиции одной накладной попадают в **одну** поставку, у неё есть автор и
 * время, суммы совпадают со строками, а позиции открываются отдельным запросом.
 *
 * Usage: node scripts/src/check-deliveries.mjs
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

const products = (await call("GET", "/api/products")).body ?? [];
const stock = products.filter((item) => item.productType === "stock").slice(0, 3);
if (stock.length < 3) throw new Error("в демо-данных мало товаров склада");

console.log("=== 1. Поставка из накладной — одна запись ===");
const orderNumber = `ПОСТАВКА-${Date.now()}`;
const bulk = await call("POST", "/api/movements/bulk-receipt", {
  positions: [
    { productId: stock[0].id, quantity: 4, unitPrice: 100 },
    { productId: stock[1].id, quantity: 2, unitPrice: 250 },
  ],
  orderNumber,
  reason: "Проверка поставок",
});
record("накладная проведена", bulk.status === 201, `статус ${bulk.status}`);

const list = await call("GET", "/api/deliveries?limit=10");
record("список поставок отдаётся", list.status === 200, `статус ${list.status}`);
const found = (list.body?.items ?? []).find((item) => item.orderNumber === orderNumber);
record("накладная попала в список как одна поставка", Boolean(found), JSON.stringify(list.body?.items?.slice(0, 2))?.slice(0, 240));
record(
  "в поставке две позиции и четыре единицы",
  found?.positions === 3 - 1 && found?.quantity === 6,
  JSON.stringify({ positions: found?.positions, quantity: found?.quantity }),
);
record(
  "сумма совпадает со строками",
  Math.abs((found?.cost ?? 0) - (4 * 100 + 2 * 250)) < 0.01,
  `cost ${found?.cost}, ожидалось ${4 * 100 + 2 * 250}`,
);
record(
  "у поставки есть автор и время",
  Boolean(found?.createdByName) && Boolean(found?.deliveredAt),
  JSON.stringify({ автор: found?.createdByName, время: found?.deliveredAt }),
);
record(
  "видны названия позиций",
  (found?.products ?? []).length >= 2,
  JSON.stringify(found?.products),
);

console.log("=== 2. Позиции поставки открываются отдельно ===");
const detail = await call("GET", `/api/deliveries/${encodeURIComponent(found?.key ?? "")}`);
record("позиции отдаются", detail.status === 200, `статус ${detail.status}`);
record(
  "позиций ровно две",
  detail.body?.movements?.length === 2,
  `позиций ${detail.body?.movements?.length}`,
);
record(
  "в позициях те же товары и количество",
  JSON.stringify((detail.body?.movements ?? []).map((movement) => [movement.productName, movement.quantity]).sort()) ===
    JSON.stringify(
      [
        [stock[0].name, 4],
        [stock[1].name, 2],
      ].sort(),
    ),
  JSON.stringify((detail.body?.movements ?? []).map((movement) => [movement.productName, movement.quantity])),
);
record(
  "в деталях та же сумма и автор",
  Math.abs((detail.body?.delivery?.cost ?? 0) - (found?.cost ?? -1)) < 0.01 &&
    detail.body?.delivery?.createdByName === found?.createdByName,
  JSON.stringify({ cost: detail.body?.delivery?.cost, автор: detail.body?.delivery?.createdByName }),
);

console.log("=== 3. Одиночный приход — своя поставка ===");
const single = await call("POST", "/api/movements", {
  productId: stock[2].id,
  type: "receipt",
  quantity: 7,
  unitPrice: 42,
});
record("одиночный приход проведён", single.status === 201, `статус ${single.status}`);
const afterSingle = (await call("GET", "/api/deliveries?limit=10")).body?.items ?? [];
record(
  "одиночный приход стал отдельной поставкой",
  afterSingle.some((item) => item.positions === 1 && Math.abs(item.cost - 7 * 42) < 0.01),
  JSON.stringify(afterSingle.slice(0, 3).map((item) => ({ positions: item.positions, cost: item.cost }))),
);

console.log("=== 4. Поиск и фильтры ===");
const byOrder = await call("GET", `/api/deliveries?search=${encodeURIComponent(orderNumber)}`);
record(
  "поиск по номеру накладной находит одну поставку",
  byOrder.body?.items?.length === 1 && byOrder.body?.items[0]?.orderNumber === orderNumber,
  JSON.stringify(byOrder.body?.items?.map((item) => item.orderNumber)),
);

const byProduct = await call("GET", `/api/deliveries?search=${encodeURIComponent(stock[0].name.slice(0, 12))}`);
record(
  "поиск по названию товара что-то находит",
  (byProduct.body?.items?.length ?? 0) >= 1,
  `найдено ${byProduct.body?.items?.length}`,
);

const future = await call("GET", "/api/deliveries?from=2099-01-01");
record(
  "фильтр по дате прихода отсекает всё будущее",
  future.body?.items?.length === 0,
  `найдено ${future.body?.items?.length}`,
);
record(
  "общее количество считается с учётом фильтра",
  future.body?.total === 0,
  `total ${future.body?.total}`,
);

console.log("=== 5. Ошибки ===");
const badKey = await call("GET", "/api/deliveries/not-a-key");
record("несуществующая поставка — 404", badKey.status === 404, `статус ${badKey.status}`);
const tooBig = await call("GET", "/api/deliveries?limit=1000");
record("слишком большой limit отклонён", tooBig.status === 400, `статус ${tooBig.status}`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
