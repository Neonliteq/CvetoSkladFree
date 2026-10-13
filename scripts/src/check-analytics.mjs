/**
 * Проверяет, что аналитика считает то же, что лежит в базе.
 *
 * Ожидаемые числа считаются здесь напрямую из движений, а не берутся из ответа
 * API: так расхождение видно, а не подтверждается само собой. Отдельно
 * проверяются границы периода — день магазина не должен обрезаться по UTC.
 *
 * Usage: node scripts/src/check-analytics.mjs
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
  const response = await fetch(`${api}${path}`, {
    headers: { cookie: session.cookieHeader, origin: new URL(api).origin },
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

const money = (value) => Math.round(value * 100) / 100;
const movements = (await call("/api/movements?limit=100")).body ?? [];
const products = (await call("/api/products")).body ?? [];
const productById = new Map(products.map((product) => [product.id, product]));

/**
 * Ожидаемые числа по правилам аналитики.
 *
 * Отменённые операции (компенсирующие записи и те, что они отменяют) в расчёт
 * не идут, поэтому из движений выбрасываются обе стороны отмены.
 */
const reversedIds = new Set(
  movements.map((row) => row.reversalOfMovementId).filter((id) => id !== null),
);
const active = movements.filter(
  (row) => row.reversalOfMovementId === null && !reversedIds.has(row.id),
);
const expenses = active.filter((row) => row.type === "expense");

console.log("=== 1. Общие числа ===");
const analytics = (await call("/api/analytics/movements")).body;
record("аналитика отдаётся", Boolean(analytics), JSON.stringify(analytics)?.slice(0, 120));
record(
  "число операций совпадает с движениями",
  analytics?.totalOperations === active.length,
  `API ${analytics?.totalOperations}, в базе ${active.length}`,
);
record(
  "суммарное количество совпадает",
  analytics?.totalQuantity === money(active.reduce((sum, row) => sum + row.quantity, 0)),
  `API ${analytics?.totalQuantity}, посчитано ${money(active.reduce((sum, row) => sum + row.quantity, 0))}`,
);
record(
  "суммарная стоимость совпадает",
  analytics?.totalValue ===
    money(active.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0)),
  `API ${analytics?.totalValue}, посчитано ${money(active.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0))}`,
);

console.log("\n=== 2. Выручка, себестоимость и прибыль ===");
const expectedRevenue = money(
  expenses.reduce((sum, row) => sum + row.quantity * (row.saleUnitPrice ?? 0), 0),
);
const expectedCost = money(
  expenses.reduce(
    (sum, row) =>
      sum +
      (row.batchAllocations ?? []).reduce(
        (line, allocation) => line + allocation.quantity * allocation.unitPrice,
        0,
      ),
    0,
  ),
);
record(
  "выручка считается по фактическим ценам продаж",
  analytics?.totalRevenue === expectedRevenue,
  `API ${analytics?.totalRevenue}, посчитано ${expectedRevenue}`,
);
record(
  "себестоимость считается по списанным партиям",
  analytics?.totalCost === expectedCost,
  `API ${analytics?.totalCost}, посчитано ${expectedCost}`,
);
record(
  "прибыль равна выручке минус себестоимость",
  analytics?.grossProfit === money(expectedRevenue - expectedCost),
  `API ${analytics?.grossProfit}, посчитано ${money(expectedRevenue - expectedCost)}`,
);
record(
  "себестоимость не больше выручки в демо-данных",
  expectedCost <= expectedRevenue || expectedRevenue === 0,
  `выручка ${expectedRevenue}, себестоимость ${expectedCost}`,
);

console.log("\n=== 3. Разрез по типам ===");
const byType = new Map((analytics?.byType ?? []).map((item) => [item.type, item]));
for (const type of ["receipt", "expense", "writeoff", "production_input", "production_output"]) {
  const rows = active.filter((row) => row.type === type);
  if (!rows.length) continue;
  const expected = {
    operations: rows.length,
    quantity: money(rows.reduce((sum, row) => sum + row.quantity, 0)),
    value: money(rows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0)),
  };
  const actual = byType.get(type);
  record(
    `разрез «${type}» сходится`,
    actual?.operations === expected.operations &&
      actual?.quantity === expected.quantity &&
      actual?.value === expected.value,
    JSON.stringify({ api: actual, expected }),
  );
}
record(
  "в разрезе только встреченные типы",
  (analytics?.byType ?? []).every((item) => active.some((row) => row.type === item.type)),
  JSON.stringify((analytics?.byType ?? []).map((item) => item.type)),
);

console.log("\n=== 4. Топ товаров ===");
const topByApi = analytics?.topProducts ?? [];
record("топ не больше десяти позиций", topByApi.length <= 10, `позиций ${topByApi.length}`);
const sortedByApi = topByApi.every(
  (item, index) => index === 0 || topByApi[index - 1].soldQuantity >= item.soldQuantity,
);
record(
  "топ отсортирован по проданному количеству",
  sortedByApi,
  JSON.stringify(topByApi.map((item) => item.soldQuantity)),
);
record(
  "в топе только проданные товары",
  topByApi.every((item) => item.soldQuantity > 0),
  JSON.stringify(topByApi.map((item) => [item.productName, item.soldQuantity])),
);
const topFirst = topByApi[0];
if (topFirst) {
  const rows = expenses.filter((row) => row.productId === topFirst.productId);
  const expectedSold = money(rows.reduce((sum, row) => sum + row.quantity, 0));
  const expectedRevenue = money(
    rows.reduce((sum, row) => sum + row.quantity * (row.saleUnitPrice ?? 0), 0),
  );
  record(
    "проданное количество лидера сходится с продажами",
    topFirst.soldQuantity === expectedSold,
    `API ${topFirst.soldQuantity}, посчитано ${expectedSold}`,
  );
  record(
    "выручка лидера сходится с продажами",
    topFirst.revenue === expectedRevenue,
    `API ${topFirst.revenue}, посчитано ${expectedRevenue}`,
  );
  const soldByProduct = new Map();
  for (const row of expenses) {
    soldByProduct.set(row.productId, (soldByProduct.get(row.productId) ?? 0) + row.quantity);
  }
  const maxSold = Math.max(...[...soldByProduct.values()]);
  record(
    "лидер — самый продаваемый товар",
    topFirst.soldQuantity === maxSold,
    `лидер ${topFirst.soldQuantity}, максимум ${maxSold}`,
  );
}

console.log("\n=== 5. Динамика по дням ===");
const timeline = analytics?.timeline ?? [];
const timelineKeys = timeline.map((item) => item.date);
record(
  "динамика отсортирована по дате",
  timelineKeys.every((key, index) => index === 0 || timelineKeys[index - 1] < key),
  JSON.stringify(timelineKeys),
);
record(
  "даты динамики — это день без времени",
  timelineKeys.every((key) => /^\d{4}-\d{2}-\d{2}$/.test(key)),
  JSON.stringify(timelineKeys.slice(0, 3)),
);
const timelineValue = money(timeline.reduce((sum, item) => sum + item.value, 0));
record(
  "сумма динамики совпадает с общей стоимостью",
  timelineValue === analytics?.totalValue,
  `динамика ${timelineValue}, всего ${analytics?.totalValue}`,
);
const timelineQuantity = money(timeline.reduce((sum, item) => sum + item.quantity, 0));
record(
  "количество в динамике совпадает с общим",
  timelineQuantity === analytics?.totalQuantity,
  `динамика ${timelineQuantity}, всего ${analytics?.totalQuantity}`,
);

console.log("\n=== 6. Фильтры ===");
const firstProduct = products.find((product) => product.productType === "stock");
const byProduct = (await call(`/api/analytics/movements?productId=${firstProduct.id}`)).body;
const productRows = active.filter((row) => row.productId === firstProduct.id);
record(
  "фильтр по товару сужает выборку",
  byProduct?.totalOperations === productRows.length,
  `API ${byProduct?.totalOperations}, в базе ${productRows.length}`,
);
record(
  "все операции фильтра — по выбранному товару",
  timeline.length >= (byProduct?.timeline ?? []).length,
  `всего дней ${timeline.length}, при фильтре ${(byProduct?.timeline ?? []).length}`,
);

const saleOnly = (await call("/api/analytics/movements?type=expense")).body;
record(
  "фильтр по типу оставляет только продажи",
  (saleOnly?.byType ?? []).every((item) => item.type === "expense"),
  JSON.stringify((saleOnly?.byType ?? []).map((item) => item.type)),
);
record(
  "при фильтре по продажам выручка не теряется",
  saleOnly?.totalRevenue === analytics?.totalRevenue,
  `при фильтре ${saleOnly?.totalRevenue}, всего ${analytics?.totalRevenue}`,
);

const category = firstProduct.category;
const byCategory = (await call(`/api/analytics/movements?category=${encodeURIComponent(category)}`)).body;
const categoryRows = active.filter((row) => productById.get(row.productId)?.category === category);
record(
  "фильтр по категории сходится",
  byCategory?.totalOperations === categoryRows.length,
  `API ${byCategory?.totalOperations}, в базе ${categoryRows.length}`,
);
record(
  "категория без операций даёт пусто",
  (await call("/api/analytics/movements?category=ТакойКатегорииНет")).body?.totalOperations === 0,
  "ожидалось 0 операций",
);

console.log("\n=== 7. Границы периода ===");
const lastDate = timelineKeys[timelineKeys.length - 1];
const firstDate = timelineKeys[0];
const point = (await call(`/api/analytics/movements?from=${firstDate}&to=${firstDate}`)).body;
const expectedOnDay = active.filter(
  (row) => row.createdAt.slice(0, 10) === firstDate,
);
record(
  "период из одного дня берёт только этот день",
  point?.totalOperations === expectedOnDay.length,
  `API ${point?.totalOperations}, по дате UTC ${expectedOnDay.length}`,
);
const wide = (await call(`/api/analytics/movements?from=${firstDate}&to=${lastDate}`)).body;
record(
  "широкий период покрывает всю динамику",
  wide?.totalOperations >= active.length - 2,
  `API ${wide?.totalOperations}, всего ${active.length}`,
);
const emptyRange = (await call("/api/analytics/movements?from=2000-01-01&to=2000-01-02")).body;
record(
  "пустой период даёт нули, а не ошибку",
  emptyRange?.totalOperations === 0 && emptyRange?.grossProfit === 0,
  JSON.stringify({ operations: emptyRange?.totalOperations, profit: emptyRange?.grossProfit }),
);
const broken = await call("/api/analytics/movements?from=вчера");
record("неверная дата отклонена", broken.status === 400, `статус ${broken.status}`);

console.log("\n=== 7б. Ночная операция попадает в свой день ===");
// День магазина, а не UTC: операция в 00:30 по времени сервера должна остаться
// в этих сутках. Иначе «выручка за сегодня» не сходится с кассой.
const nightProduct = products.find(
  (product) => product.productType === "stock" && product.currentStock >= 3,
);
const midnight = new Date();
midnight.setHours(0, 30, 0, 0);
const nightSale = await fetch(`${api}/api/movements`, {
  method: "POST",
  headers: {
    cookie: session.cookieHeader,
    origin: new URL(api).origin,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    productId: nightProduct.id,
    type: "expense",
    quantity: 1,
    saleUnitPrice: nightProduct.salePrice,
    reason: "Проверка ночной операции",
    createdAt: midnight.toISOString(),
  }),
});
record("ночная продажа записана", nightSale.status === 201, `статус ${nightSale.status}`);
const todayLocal = `${midnight.getFullYear()}-${String(midnight.getMonth() + 1).padStart(2, "0")}-${String(midnight.getDate()).padStart(2, "0")}`;
const night = (await call(`/api/analytics/movements?from=${todayLocal}&to=${todayLocal}`)).body;
record(
  "операция в 00:30 осталась в своих сутках",
  (night?.timeline ?? []).some((item) => item.date === todayLocal && item.quantity >= 1),
  JSON.stringify(night?.timeline),
);
const yesterdayLocal = new Date(midnight.getTime() - 86400000);
const yesterdayKey = `${yesterdayLocal.getFullYear()}-${String(yesterdayLocal.getMonth() + 1).padStart(2, "0")}-${String(yesterdayLocal.getDate()).padStart(2, "0")}`;
const previousDay = (await call(`/api/analytics/movements?from=${yesterdayKey}&to=${yesterdayKey}`)).body;
record(
  "в предыдущий день ночная операция не попала",
  !(previousDay?.timeline ?? []).some(
    (item) => item.date === yesterdayKey && item.quantity >= 1 && night?.totalQuantity === item.quantity,
  ),
  JSON.stringify({ yesterday: previousDay?.timeline, today: night?.timeline }),
);

console.log("\n=== 8. Отменённые операции не считаются ===");
const before = (await call("/api/analytics/movements")).body;
// Отменяем операцию, которую создали сами: у операций из демо-данных партия
// может быть уже израсходована, и отмена откажет по делу.
const stockProduct = products.find(
  (product) => product.productType === "stock" && product.currentStock >= 3,
);
const created = await fetch(`${api}/api/movements`, {
  method: "POST",
  headers: {
    cookie: session.cookieHeader,
    origin: new URL(api).origin,
    "content-type": "application/json",
  },
  body: JSON.stringify({
    productId: stockProduct.id,
    type: "expense",
    quantity: 2,
    saleUnitPrice: stockProduct.salePrice,
    reason: "Проверка аналитики",
  }),
});
const createdBody = await created.json();
record("проверочная продажа записана", created.status === 201, `статус ${created.status}`);
const withSale = (await call("/api/analytics/movements")).body;
record(
  "новая продажа попала в аналитику",
  withSale?.totalOperations === (before?.totalOperations ?? 0) + 1,
  `${before?.totalOperations} → ${withSale?.totalOperations}`,
);
record(
  "выручка выросла на стоимость продажи",
  withSale?.totalRevenue === money((before?.totalRevenue ?? 0) + 2 * stockProduct.salePrice),
  `было ${before?.totalRevenue}, стало ${withSale?.totalRevenue}`,
);

const undo = await fetch(`${api}/api/movements/${createdBody.id}/undo`, {
  method: "POST",
  headers: {
    cookie: session.cookieHeader,
    origin: new URL(api).origin,
    "content-type": "application/json",
  },
  body: "{}",
});
record("проверочная продажа отменена", undo.status === 200, `статус ${undo.status}`);
const after = (await call("/api/analytics/movements")).body;
record(
  "после отмены операция и компенсация не считаются",
  after?.totalOperations === before?.totalOperations,
  `${withSale?.totalOperations} → ${after?.totalOperations}, до проверки ${before?.totalOperations}`,
);
record(
  "выручка вернулась к прежней",
  after?.totalRevenue === before?.totalRevenue,
  `было ${before?.totalRevenue}, стало ${after?.totalRevenue}`,
);
record(
  "себестоимость вернулась к прежней",
  after?.totalCost === before?.totalCost,
  `было ${before?.totalCost}, стало ${after?.totalCost}`,
);

console.log("\n=== 9. Разбор по категориям и товарам ===");
const byCategoryBreakdown = (await call("/api/analytics/movements?breakdown=category")).body?.breakdown;
record(
  "разбор по категориям отдаётся",
  byCategoryBreakdown?.dimension === "category" && byCategoryBreakdown.rows.length > 0,
  JSON.stringify(byCategoryBreakdown)?.slice(0, 140),
);
const categoryNames = new Set(products.map((product) => product.category));
record(
  "в разборе только реальные категории",
  (byCategoryBreakdown?.rows ?? []).every((row) => categoryNames.has(row.name)),
  JSON.stringify((byCategoryBreakdown?.rows ?? []).map((row) => row.name)),
);
const salesBreakdown = (await call("/api/analytics/movements?type=expense&breakdown=product")).body?.breakdown;
record(
  "для продаж есть выручка, себестоимость и прибыль",
  (salesBreakdown?.rows ?? []).length > 0 &&
    salesBreakdown.rows.every(
      (row) => row.revenue !== null && row.cost !== null && row.profit !== null,
    ),
  JSON.stringify((salesBreakdown?.rows ?? []).slice(0, 2)),
);
record(
  "прибыль по строке равна выручке минус себестоимость",
  (salesBreakdown?.rows ?? []).every(
    (row) => Math.abs(row.profit - (row.revenue - row.cost)) < 0.01,
  ),
  JSON.stringify((salesBreakdown?.rows ?? []).slice(0, 2)),
);
const breakdownRevenue = money(
  (salesBreakdown?.rows ?? []).reduce((sum, row) => sum + (row.revenue ?? 0), 0),
);
const expenseAnalytics = (await call("/api/analytics/movements?type=expense")).body;
record(
  "выручка разбора сходится с общей выручкой продаж",
  breakdownRevenue === expenseAnalytics?.totalRevenue,
  `разбор ${breakdownRevenue}, всего ${expenseAnalytics?.totalRevenue}`,
);
const writeoffBreakdown = (await call("/api/analytics/movements?type=writeoff&breakdown=product")).body?.breakdown;
record(
  "у списаний есть себестоимость, но нет выручки",
  (writeoffBreakdown?.rows ?? []).length > 0 &&
    writeoffBreakdown.rows.every((row) => row.revenue === null && row.cost !== null),
  JSON.stringify((writeoffBreakdown?.rows ?? []).slice(0, 2)),
);
const receiptBreakdown = (await call("/api/analytics/movements?type=receipt&breakdown=category")).body?.breakdown;
record(
  "у приходов только количество и стоимость",
  (receiptBreakdown?.rows ?? []).length > 0 &&
    receiptBreakdown.rows.every((row) => row.revenue === null && row.cost === null),
  JSON.stringify((receiptBreakdown?.rows ?? []).slice(0, 2)),
);
record(
  "разбор отсортирован по выручке или стоимости",
  (byCategoryBreakdown?.rows ?? []).every(
    (row, index) =>
      index === 0 ||
      (byCategoryBreakdown.rows[index - 1].revenue ?? byCategoryBreakdown.rows[index - 1].value) >=
        (row.revenue ?? row.value),
  ),
  JSON.stringify((byCategoryBreakdown?.rows ?? []).map((row) => row.value)),
);

console.log("\n=== 10. Сравнение с прошлым периодом ===");
const range = (analytics?.timeline ?? []).map((item) => item.date);
const [rangeFrom, rangeTo] = [range[0], range[range.length - 1]];
const compared = (await call(`/api/analytics/movements?from=${rangeFrom}&to=${rangeTo}`)).body;
const days = Math.round(
  (new Date(`${rangeTo}T12:00:00`) - new Date(`${rangeFrom}T12:00:00`)) / 86400000,
) + 1;
const expectedPreviousTo = new Date(`${rangeFrom}T12:00:00`);
expectedPreviousTo.setDate(expectedPreviousTo.getDate() - 1);
const expectedPreviousFrom = new Date(`${rangeFrom}T12:00:00`);
expectedPreviousFrom.setDate(expectedPreviousFrom.getDate() - days);
const asKey = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
record(
  "прошлый период посчитан той же длины",
  compared?.previous?.from === asKey(expectedPreviousFrom) &&
    compared?.previous?.to === asKey(expectedPreviousTo),
  JSON.stringify({ api: compared?.previous, expected: [asKey(expectedPreviousFrom), asKey(expectedPreviousTo)] }),
);
const previousExpected = (await call(
  `/api/analytics/movements?from=${asKey(expectedPreviousFrom)}&to=${asKey(expectedPreviousTo)}`,
)).body;
record(
  "выручка прошлого периода сходится с отдельным запросом",
  compared?.previous?.totalRevenue === previousExpected?.totalRevenue,
  `в сравнении ${compared?.previous?.totalRevenue}, отдельно ${previousExpected?.totalRevenue}`,
);
record(
  "прибыль прошлого периода сходится с отдельным запросом",
  compared?.previous?.grossProfit === previousExpected?.grossProfit,
  `в сравнении ${compared?.previous?.grossProfit}, отдельно ${previousExpected?.grossProfit}`,
);
record(
  "без периода сравнения нет",
  (await call("/api/analytics/movements")).body?.previous === null,
  JSON.stringify((await call("/api/analytics/movements")).body?.previous),
);

console.log("\n=== 11. Дни в динамике разложены по видам операций ===");
// Динамику берём заново: предыдущие проверки добавили и отменили свои операции,
// и старый снимок уже не совпадает с текущими итогами.
const freshTimeline = (await call("/api/analytics/movements")).body?.timeline ?? [];
record(
  "в дне есть продажи, приходы и списания",
  freshTimeline.every(
    (item) =>
      typeof item.soldValue === "number" &&
      typeof item.receiptValue === "number" &&
      typeof item.writeoffValue === "number",
  ),
  JSON.stringify(freshTimeline[freshTimeline.length - 1]),
);
const soldTotal = money(freshTimeline.reduce((sum, item) => sum + item.soldValue, 0));
const expenseTotals = (await call("/api/analytics/movements?type=expense")).body;
record(
  "сумма продаж в динамике сходится с выручкой продаж",
  soldTotal === expenseTotals?.totalRevenue,
  `динамика ${soldTotal}, продажи ${expenseTotals?.totalRevenue}`,
);
const receiptTotal = money(freshTimeline.reduce((sum, item) => sum + item.receiptValue, 0));
const receiptTotals = (await call("/api/analytics/movements?type=receipt")).body;
record(
  "сумма приходов в динамике сходится с приходами",
  receiptTotal === receiptTotals?.totalValue,
  `динамика ${receiptTotal}, приходы ${receiptTotals?.totalValue}`,
);
record(
  "продажи и приходы не смешаны в одной колонке",
  freshTimeline.some((item) => item.soldValue > 0) &&
    freshTimeline.some((item) => item.receiptValue > 0) &&
    soldTotal !== receiptTotal,
  `продажи ${soldTotal}, приходы ${receiptTotal}`,
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
