/**
 * Проверяет архив товаров.
 *
 * Товар с историей операций нельзя удалить, поэтому он уходит в архив: пропадает
 * из рабочего списка, остаётся в базе и возвращается обратно.
 *
 * Usage: node scripts/src/check-product-archive.mjs
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
const call = async (path, init = {}) => {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
};

console.log("=== 1. Заводим товар для проверки ===");
const created = await call("/api/products", {
  method: "POST",
  body: JSON.stringify({
    name: "Архивный тест",
    category: "Проверка",
    unit: "шт",
    purchasePrice: 100,
    markupPercent: 50,
    minimumStock: 0,
    shelfLifeDays: 0,
  }),
});
record("товар создан", created.status === 201 && created.body?.id > 0, `статус ${created.status}: ${JSON.stringify(created.body)?.slice(0, 300)}`);
const productId = created.body?.id;

const listNames = async (query = "") => {
  const response = await call(`/api/products${query}`);
  return { status: response.status, items: response.body ?? [] };
};

const beforeArchive = await listNames();
record(
  "новый товар виден в рабочем списке",
  beforeArchive.items.some((item) => item.id === productId),
  `товаров ${beforeArchive.items.length}`,
);
record(
  "у нового товара нет даты архивации",
  beforeArchive.items.find((item) => item.id === productId)?.archivedAt === null,
  JSON.stringify(beforeArchive.items.find((item) => item.id === productId)?.archivedAt),
);

console.log("\n=== 2. Товар с историей нельзя удалить, он уходит в архив ===");
// Операция даёт товару историю: именно из-за неё удаление становится архивом.
const receipt = await call("/api/movements", {
  method: "POST",
  body: JSON.stringify({
    productId,
    type: "receipt",
    quantity: 5,
    purchasePrice: 100,
    reason: "Проверка архива",
  }),
});
record("приход проведён", receipt.status === 201 || receipt.status === 200, `статус ${receipt.status}`);

// Товар с остатком в архив не уходит: остаток — это деньги на складе, сначала
// его нужно списать. Проверяем подсказку сервера, иначе владелец не поймёт,
// почему кнопка не сработала.
const blocked = await call(`/api/products/${productId}`, { method: "DELETE" });
record(
  "товар с остатком в архив не уходит",
  blocked.status === 400 && String(blocked.body?.error ?? "").includes("обнулите остаток"),
  `статус ${blocked.status}: ${JSON.stringify(blocked.body)?.slice(0, 200)}`,
);

const writeoff = await call("/api/movements", {
  method: "POST",
  body: JSON.stringify({
    productId,
    type: "writeoff",
    quantity: 5,
    reason: "Списание перед архивацией",
  }),
});
record("остаток списан", writeoff.status === 201 || writeoff.status === 200, `статус ${writeoff.status}`);

const deleted = await call(`/api/products/${productId}`, { method: "DELETE" });
record("удаление товара с историей принято", deleted.status === 204, `статус ${deleted.status}: ${JSON.stringify(deleted.body)?.slice(0, 200)}`);

const afterArchive = await listNames();
record(
  "товар исчез из рабочего списка",
  !afterArchive.items.some((item) => item.id === productId),
  `товаров ${afterArchive.items.length}`,
);
record(
  "список без архива короче на один товар",
  afterArchive.items.length === beforeArchive.items.length - 1,
  `${beforeArchive.items.length} → ${afterArchive.items.length}`,
);

console.log("\n=== 3. Архив доступен отдельным запросом ===");
const archivedOnly = await listNames("?archived=true");
const archivedRow = archivedOnly.items.find((item) => item.id === productId);
record("архив отдаётся", archivedOnly.status === 200 && Array.isArray(archivedOnly.items), `статус ${archivedOnly.status}`);
record("в архиве только архивные товары", archivedOnly.items.every((item) => item.archivedAt), JSON.stringify(archivedOnly.items.map((item) => item.archivedAt)));
record("наш товар лежит в архиве", Boolean(archivedRow), `id ${productId}`);
record("у архивного товара стоит дата архивации", Boolean(archivedRow?.archivedAt), JSON.stringify(archivedRow?.archivedAt));

const withArchived = await listNames("?includeArchived=true");
record(
  "includeArchived добавляет архив к рабочему списку",
  withArchived.items.some((item) => item.id === productId) &&
    withArchived.items.length === archivedOnly.items.length + afterArchive.items.length,
  `${afterArchive.items.length} + ${archivedOnly.items.length} = ${withArchived.items.length}`,
);

console.log("\n=== 4. История операций архивного товара сохранена ===");
const movements = await call(`/api/movements?limit=100&search=${encodeURIComponent("Архивный тест")}`);
record(
  "операция по архивному товару на месте",
  (movements.body ?? []).some((row) => row.productId === productId),
  `найдено ${movements.body?.length ?? 0}`,
);
const receipts = await call(`/api/products/${productId}/receipts`);
record(
  "приходы товара по-прежнему читаются",
  receipts.status === 200 && (receipts.body ?? []).length > 0,
  `статус ${receipts.status}, приходов ${receipts.body?.length ?? 0}`,
);

console.log("\n=== 5. Возврат из архива ===");
const restored = await call(`/api/products/${productId}/restore`, { method: "POST" });
record("возврат принят", restored.status === 200, `статус ${restored.status}`);
record("сервер вернул товар без даты архивации", restored.body?.archivedAt === null, JSON.stringify(restored.body?.archivedAt ?? `поле отсутствует: ${Object.keys(restored.body ?? {}).slice(0, 4)}`));

const afterRestore = await listNames();
record(
  "товар снова в рабочем списке",
  afterRestore.items.some((item) => item.id === productId),
  `товаров ${afterRestore.items.length}`,
);
const archiveAfterRestore = await listNames("?archived=true");
record(
  "в архиве товара больше нет",
  !archiveAfterRestore.items.some((item) => item.id === productId),
  `в архиве ${archiveAfterRestore.items.length}`,
);

console.log("\n=== 6. Остаток архивного товара не разошёлся ===");
const restoredProduct = afterRestore.items.find((item) => item.id === productId);
record(
  "остаток сохранился",
  restoredProduct?.currentStock === 0,
  `остаток ${restoredProduct?.currentStock}`,
);

console.log("\n=== 7. Архив не мешает поиску и фильтрам ===");
const archiveAgain = await call(`/api/products/${productId}`, { method: "DELETE" });
record("товар снова в архиве", archiveAgain.status === 204, `статус ${archiveAgain.status}`);
const searchArchived = await listNames("?search=Архивный");
record(
  "обычный поиск не находит архивный товар",
  !searchArchived.items.some((item) => item.id === productId),
  `найдено ${searchArchived.items.length}`,
);
const searchInArchive = await listNames("?archived=true&search=Архивный");
record(
  "поиск по архиву находит товар",
  searchInArchive.items.some((item) => item.id === productId),
  `найдено ${searchInArchive.items.length}`,
);
const lowStockArchive = await listNames("?archived=true&lowStock=true");
record(
  "фильтр низкого остатка работает и в архиве",
  lowStockArchive.status === 200 && lowStockArchive.items.every((item) => item.archivedAt),
  `статус ${lowStockArchive.status}, товаров ${lowStockArchive.items.length}`,
);

console.log("\n=== 8. Товар без истории удаляется окончательно ===");
const fresh = await call("/api/products", {
  method: "POST",
  body: JSON.stringify({
    name: "Удаляемый тест",
    category: "Проверка",
    unit: "шт",
    purchasePrice: 10,
    markupPercent: 0,
    minimumStock: 0,
    shelfLifeDays: 0,
  }),
});
const freshId = fresh.body?.id;
const hardDelete = await call(`/api/products/${freshId}`, { method: "DELETE" });
record("товар без истории удаляется", hardDelete.status === 204, `статус ${hardDelete.status}`);
const allAfter = await listNames("?includeArchived=true");
record(
  "товар без истории исчез совсем",
  !allAfter.items.some((item) => item.id === freshId),
  `товаров ${allAfter.items.length}`,
);
const freshStock = (await listNames(`?includeArchived=true&search=Удаляемый`)).items;
record(
  "в базе не осталось следа удалённого товара",
  freshStock.length === 0,
  `найдено ${freshStock.length}`,
);

// Товар с историей остаётся в архиве и после уборки — но из работы уходит.
await call(`/api/products/${productId}`, { method: "DELETE" });
const cleaned = await listNames();
record(
  "тестовый товар убран из работы",
  !cleaned.items.some((item) => item.id === productId),
  `товаров ${cleaned.items.length}`,
);

console.log("\n=== 9. Архив не всплывает в сводке ===");
// Сводка считает «низкий остаток» по всем товарам сразу, своим запросом, а не
// через список склада: без фильтра архивные позиции звали закупать то, что
// магазин больше не продаёт.
//
// Товару нужна история операций: без неё `DELETE /products/:id` удаляет запись
// совсем, и проверка проходила бы даже с прежним багом. Поэтому сначала приход,
// потом списание всего остатка — и уже затем архив.
const dashboard = async () => (await call("/api/dashboard")).body ?? {};
const makeTrackedProduct = async (name, minimumStock) => {
  const created = await call("/api/products", {
    method: "POST",
    body: JSON.stringify({
      name,
      category: "Проверка",
      unit: "шт",
      purchasePrice: 50,
      markupPercent: 0,
      minimumStock,
      shelfLifeDays: 0,
    }),
  });
  const id = created.body?.id;
  await call("/api/movements", {
    method: "POST",
    body: JSON.stringify({ productId: id, type: "receipt", quantity: 4, unitPrice: 50 }),
  });
  const stock = (await call(`/api/products?includeArchived=true&search=${encodeURIComponent(name)}`))
    .body?.[0]?.currentStock;
  await call("/api/movements", {
    method: "POST",
    body: JSON.stringify({ productId: id, type: "writeoff", quantity: stock, reason: "Уборка проверки" }),
  });
  return { id, name };
};

const watcher = await makeTrackedProduct("Сводка: низкий остаток", 10);
const watcherId = watcher.id;
const beforeHide = await dashboard();
record(
  "товар с порогом и без остатка виден в низком остатке",
  (beforeHide.lowStock ?? []).some((item) => item.id === watcherId),
  JSON.stringify((beforeHide.lowStock ?? []).map((item) => item.name).slice(0, 8)),
);
record(
  "он же посчитан в числе низкого остатка",
  (beforeHide.lowStockCount ?? 0) >= (beforeHide.lowStock ?? []).length,
  `счётчик ${beforeHide.lowStockCount}, в списке ${(beforeHide.lowStock ?? []).length}`,
);

const hide = await call(`/api/products/${watcherId}`, { method: "DELETE" });
record("товар ушёл в архив", hide.status === 204, `статус ${hide.status}`);
const archived = (await call(`/api/products?archived=true&search=${encodeURIComponent(watcher.name)}`))
  .body ?? [];
record(
  "в архиве товар действительно лежит, а не удалён",
  archived.some((item) => item.id === watcherId),
  `в архиве найдено ${archived.length}`,
);

const afterHide = await dashboard();
record(
  "архивный товар исчез из низкого остатка",
  !(afterHide.lowStock ?? []).some((item) => item.id === watcherId),
  JSON.stringify((afterHide.lowStock ?? []).map((item) => `${item.name}(${item.currentStock}/${item.minimumStock})`).slice(0, 8)),
);
record(
  "счётчик низкого остатка уменьшился",
  (afterHide.lowStockCount ?? 0) === (beforeHide.lowStockCount ?? 0) - 1,
  `${beforeHide.lowStockCount} → ${afterHide.lowStockCount}`,
);
record(
  "архивный товар не виден и в истекающих партиях",
  !(afterHide.expiring ?? []).some((item) => item.productId === watcherId),
  JSON.stringify((afterHide.expiring ?? []).map((item) => item.productName)),
);
record(
  "остальные товары сводки не пропали",
  (afterHide.lowStock ?? []).length === (beforeHide.lowStock ?? []).length - 1,
  `в списке ${(beforeHide.lowStock ?? []).length} → ${(afterHide.lowStock ?? []).length}`,
);
record(
  "общее количество товаров в сводке тоже без архива",
  (afterHide.totalProducts ?? 0) === (beforeHide.totalProducts ?? 0) - 1,
  `${beforeHide.totalProducts} → ${afterHide.totalProducts}`,
);

// Товар с нулевым порогом: порог не задан, значит и «низкого остатка» нет.
// Раньше такие позиции висели в сводке вечно — 0 остатка «меньше» нулевого порога.
const noThreshold = await makeTrackedProduct("Сводка: без порога", 0);
const withNoThreshold = await dashboard();
record(
  "товар без порога не считается низким остатком",
  !(withNoThreshold.lowStock ?? []).some((item) => item.id === noThreshold.id),
  JSON.stringify((withNoThreshold.lowStock ?? []).map((item) => item.name).slice(0, 8)),
);
await call(`/api/products/${noThreshold.id}`, { method: "DELETE" });

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
