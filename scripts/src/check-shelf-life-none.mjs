/**
 * Товар без срока годности.
 *
 * Смысл: для упаковки, ленты, ваз и прочего, что не портится, дата истечения бессмысленна.
 * В базе это `shelf_life_days = 0`, и приход такого товара не должен получать `expires_at`.
 *
 * Проверяется то, что легко сломать незаметно: дата не появляется, товар не попадает в
 * «истекает скоро», и включение срока обратно снова даёт дату у следующих приходов.
 *
 * Usage: node scripts/src/check-shelf-life-none.mjs
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

const stamp = Date.now();
const name = `Упаковка без срока ${stamp}`;

console.log("=== 1. Товар создаётся без срока годности ===");
const created = await call("POST", "/api/products", {
  name,
  category: "Упаковка",
  unit: "упак.",
  minimumStock: 0,
  shelfLifeDays: 0,
  aliases: [],
});
record(
  "товар создан",
  created.status === 201,
  `статус ${created.status} ${JSON.stringify(created.body)?.slice(0, 160)}`,
);
const productId = created.body?.id;
record(
  "срок годности сохранён как 0",
  created.body?.shelfLifeDays === 0,
  `shelfLifeDays ${created.body?.shelfLifeDays}`,
);

console.log("=== 2. Приход не получает дату истечения ===");
const receipt = await call("POST", "/api/movements", {
  productId,
  type: "receipt",
  quantity: 10,
  unitPrice: 50,
  batchArrivalDate: new Date().toISOString().slice(0, 10),
});
record(
  "приход проведён",
  receipt.status === 201,
  `статус ${receipt.status} ${JSON.stringify(receipt.body)?.slice(0, 160)}`,
);
record(
  "у операции нет даты истечения",
  receipt.body?.expiresAt === null || receipt.body?.expiresAt === undefined,
  `expiresAt ${JSON.stringify(receipt.body?.expiresAt)}`,
);

const expiring = (await call("GET", "/api/dashboard")).body?.expiring ?? [];
record(
  "товар не попал в «истекает скоро»",
  !expiring.some((batch) => batch.productId === productId),
  `в списке ${expiring.length} партий`,
);

const lowStock = (await call("GET", "/api/dashboard")).body?.lowStock ?? [];
record(
  "товар не попал в дефицит (минимум 0)",
  !lowStock.some((item) => item.id === productId),
  `в списке ${lowStock.length} позиций`,
);

console.log("=== 3. Срок можно включить обратно ===");
const withShelfLife = await call("PATCH", `/api/products/${productId}`, { shelfLifeDays: 10 });
record(
  "срок обновлён на 10 дней",
  withShelfLife.status === 200 && withShelfLife.body?.shelfLifeDays === 10,
  `статус ${withShelfLife.status}, shelfLifeDays ${withShelfLife.body?.shelfLifeDays}`,
);

const secondReceipt = await call("POST", "/api/movements", {
  productId,
  type: "receipt",
  quantity: 5,
  unitPrice: 50,
  batchArrivalDate: new Date().toISOString().slice(0, 10),
});
const expected = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
// API отдаёт полную метку времени (`2026-11-10T00:00:00.000Z`), поэтому сравниваем дату.
const dateOnly = (value) => (value ? String(value).slice(0, 10) : null);
record(
  "новый приход получил дату через 10 дней",
  dateOnly(secondReceipt.body?.expiresAt) === expected,
  `expiresAt ${secondReceipt.body?.expiresAt}, ожидалось ${expected}`,
);
record(
  "первая партия осталась без даты",
  receipt.body?.expiresAt == null,
  `первая ${JSON.stringify(receipt.body?.expiresAt)}`,
);

console.log("=== 4. Выключение срока не переписывает историю ===");
const backToNone = await call("PATCH", `/api/products/${productId}`, { shelfLifeDays: 0 });
record(
  "срок снова 0",
  backToNone.body?.shelfLifeDays === 0,
  `shelfLifeDays ${backToNone.body?.shelfLifeDays}`,
);
const thirdReceipt = await call("POST", "/api/movements", {
  productId,
  type: "receipt",
  quantity: 2,
  unitPrice: 50,
});
record(
  "третий приход без даты",
  thirdReceipt.body?.expiresAt == null,
  `expiresAt ${JSON.stringify(thirdReceipt.body?.expiresAt)}`,
);

const receipts = (await call("GET", `/api/products/${productId}/receipts`)).body ?? [];
record(
  "у прежних партий даты не тронуты",
  receipts.some((item) => dateOnly(item.expiresAt) === expected) &&
    receipts.filter((item) => dateOnly(item.expiresAt) === null).length >= 2,
  JSON.stringify(receipts.map((item) => dateOnly(item.expiresAt))),
);

// Тестовый товар остаётся в базе: архивация требует нулевого остатка, а он нужен был для
// проверки приходов. Следующий запуск любой проверки пересоздаёт демо-данные целиком.
console.log(`  (тестовый товар «${name}» остаётся до следующего сида)`)


const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
