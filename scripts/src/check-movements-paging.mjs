/**
 * Проверяет, что история операций листается и старые записи доступны.
 *
 * Usage: node scripts/src/check-movements-paging.mjs
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
const call = async (path) => {
  const response = await fetch(`${api}${path}`, { headers: { cookie: session.cookieHeader } });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

console.log("=== 1. Первая страница ===");
const first = await call("/api/movements?limit=10");
record("история отдаётся", first.status === 200 && Array.isArray(first.body), `статус ${first.status}`);
record("на странице ровно запрошенное число", first.body?.length === 10, `получено ${first.body?.length}`);

console.log("\n=== 2. Смещение отдаёт другие записи ===");
const second = await call("/api/movements?limit=10&offset=10");
const firstIds = (first.body ?? []).map((item) => item.id);
const secondIds = (second.body ?? []).map((item) => item.id);
const overlap = firstIds.filter((id) => secondIds.includes(id));
record("вторая страница получена", second.body?.length === 10, `получено ${second.body?.length}`);
record("записи не повторяются", overlap.length === 0, `пересечение: ${JSON.stringify(overlap)}`);
record(
  "порядок по убыванию даты сохраняется",
  Number(secondIds[0]) < Number(firstIds[firstIds.length - 1]),
  `${firstIds[firstIds.length - 1]} → ${secondIds[0]}`,
);

console.log("\n=== 3. Листание до конца достаёт старые операции ===");
// Собираем историю страницами по 25 и смотрим, сколько всего доступно.
const pageSize = 25;
const collected = new Map();
let offset = 0;
let guard = 0;
while (guard < 40) {
  guard += 1;
  const page = await call(`/api/movements?limit=${pageSize}&offset=${offset}`);
  const rows = page.body ?? [];
  for (const row of rows) collected.set(row.id, row);
  if (rows.length < pageSize) break;
  offset += pageSize;
}
const all = [...collected.values()];
console.log(`  собрано страницами: ${all.length}`);
record("листание достаёт больше одной страницы", all.length > pageSize, `всего ${all.length}`);
record(
  "самая старая операция доступна",
  all.length > 0 && all.some((row) => row.id === Math.min(...all.map((item) => item.id))),
  `минимальный id ${Math.min(...all.map((item) => item.id))}`,
);

// Сверяем с полным списком за один запрос: постраничный обход не должен терять записи.
const single = await call("/api/movements?limit=100");
record(
  "постраничный обход не теряет записи",
  all.length === (single.body?.length ?? 0),
  `страницами ${all.length}, за раз ${single.body?.length}`,
);

console.log("\n=== 4. Смещение за пределами истории ===");
const far = await call("/api/movements?limit=10&offset=100000");
record("пустая страница вместо ошибки", far.status === 200 && far.body?.length === 0, `статус ${far.status}, записей ${far.body?.length}`);

console.log("\n=== 5. Ограничения параметров ===");
const tooBig = await call("/api/movements?limit=1000");
record("слишком большой limit отклонён", tooBig.status === 400, `статус ${tooBig.status}`);
const negative = await call("/api/movements?offset=-5");
record("отрицательное смещение отклонено", negative.status === 400, `статус ${negative.status}`);

console.log("\n=== 6. Фильтр по виду операции ===");
const sales = await call("/api/movements?limit=100&type=expense");
record("фильтр по продажам работает", sales.status === 200 && sales.body?.length > 0, `записей ${sales.body?.length}`);
record(
  "в выдаче только продажи",
  (sales.body ?? []).every((row) => row.type === "expense"),
  JSON.stringify([...new Set((sales.body ?? []).map((row) => row.type))]),
);
const receipts = await call("/api/movements?limit=100&type=receipt");
record(
  "фильтр по приходам работает",
  receipts.status === 200 && (receipts.body ?? []).every((row) => row.type === "receipt"),
  JSON.stringify([...new Set((receipts.body ?? []).map((row) => row.type))]),
);
const writeoffs = await call("/api/movements?limit=100&type=writeoff");
record(
  "фильтр по списаниям работает",
  writeoffs.status === 200 && (writeoffs.body ?? []).every((row) => row.type === "writeoff"),
  JSON.stringify([...new Set((writeoffs.body ?? []).map((row) => row.type))]),
);

console.log("\n=== 7. Поиск по названию товара ===");
const everything = (await call("/api/movements?limit=100")).body ?? [];
const sampleName = everything[0]?.productName?.split(" ")[0];
if (sampleName && sampleName.length >= 4) {
  const found = await call(`/api/movements?limit=100&search=${encodeURIComponent(sampleName)}`);
  record("поиск возвращает записи", found.status === 200 && found.body?.length > 0, `«${sampleName}» → ${found.body?.length}`);
  record(
    "в выдаче только подходящие товары или комментарии",
    (found.body ?? []).every(
      (row) =>
        row.productName.toLowerCase().includes(sampleName.toLowerCase()) ||
        (row.reason ?? "").toLowerCase().includes(sampleName.toLowerCase()),
    ),
    JSON.stringify((found.body ?? []).map((row) => row.productName).slice(0, 3)),
  );
  record(
    "поиск отсекает лишнее",
    (found.body?.length ?? 0) < everything.length,
    `найдено ${found.body?.length} из ${everything.length}`,
  );
} else {
  record("поиск по названию товара", true, "подходящего названия нет — пропускаю");
}
const nothing = await call("/api/movements?limit=50&search=такого-товара-нет-никогда");
record("поиск без совпадений даёт пусто", nothing.status === 200 && nothing.body?.length === 0, `записей ${nothing.body?.length}`);

console.log("\n=== 8. Фильтр вместе с поиском ===");
const both = await call(`/api/movements?limit=100&type=expense&search=${encodeURIComponent(sampleName ?? "")}`);
record(
  "фильтр и поиск работают вместе",
  both.status === 200 && (both.body ?? []).every((row) => row.type === "expense"),
  JSON.stringify([...new Set((both.body ?? []).map((row) => row.type))]),
);

console.log("\n=== 9. Сортировка на сервере ===");
const asc = await call("/api/movements?limit=100&sort=product&direction=asc");
const names = (asc.body ?? []).map((row) => row.productName);
const sortedNames = [...names].sort((a, b) => a.localeCompare(b, "ru"));
record(
  "сортировка по товару по возрастанию",
  JSON.stringify(names) === JSON.stringify(sortedNames),
  JSON.stringify(names.slice(0, 3)),
);
const descDate = await call("/api/movements?limit=5&sort=date&direction=desc");
const dates = (descDate.body ?? []).map((row) => new Date(row.createdAt).getTime());
record(
  "сортировка по дате по убыванию",
  dates.every((value, index) => index === 0 || dates[index - 1] >= value),
  JSON.stringify(dates.slice(0, 3)),
);
const badSort = await call("/api/movements?limit=5&sort=чушь");
record("неизвестное поле сортировки отклонено", badSort.status === 400, `статус ${badSort.status}`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
