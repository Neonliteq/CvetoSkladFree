/**
 * Проверяет массовый приход: несколько товаров одной накладной.
 *
 * Главное здесь — не «пять строк создались», а **целостность накладной**: ошибка в любой
 * строке не должна проводить ничего. Если бы транзакции не было, после ошибки на десятой
 * строке в базе остались бы девять приходов, остатки разъехались бы с бумагой, а
 * разбираться пришлось бы вручную.
 *
 * Проверка считает остатки и суммы сама, из ответов API и из каталога, а не сверяет ответ
 * с самим собой.
 *
 * Usage: node scripts/src/check-bulk-receipt.mjs
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
    parsed = text.slice(0, 300);
  }
  return { status: response.status, body: parsed };
};

/** Остатки всех складских товаров: снимок «до» и «после» для проверки отката. */
const allStock = async () => {
  const list = await call("GET", "/api/products");
  return new Map((list.body ?? []).map((item) => [item.id, item.currentStock]));
};

const catalog = await call("GET", "/api/products");
const stock = (catalog.body ?? []).filter((item) => item.productType === "stock").slice(0, 6);
if (stock.length < 4) throw new Error("в демо-данных мало складских товаров");

console.log("=== 1. Накладная из пяти товаров ===");
const before = await allStock();
const positions = stock.slice(0, 5).map((item, index) => ({
  productId: item.id,
  quantity: 10 + index,
  unitPrice: 100 + index * 10,
}));
const expectedQuantity = positions.reduce((sum, position) => sum + position.quantity, 0);
const expectedCost = positions.reduce((sum, position) => sum + position.quantity * position.unitPrice, 0);

const created = await call("POST", "/api/movements/bulk-receipt", {
  positions,
  orderNumber: `ПРОВЕРКА-${Date.now()}`,
  reason: "Массовый приход: проверка",
});
record(
  "накладная проведена",
  created.status === 201,
  `статус ${created.status}: ${JSON.stringify(created.body)?.slice(0, 200)}`,
);
record(
  "создано по операции на строку",
  (created.body?.movements?.length ?? 0) === 5,
  JSON.stringify({ ожидалось: 5, получено: created.body?.movements?.length }),
);
record(
  "итоговое количество совпадает с суммой строк",
  created.body?.totalQuantity === expectedQuantity,
  `${created.body?.totalQuantity} против ${expectedQuantity}`,
);
record(
  "итоговая сумма совпадает с суммой строк",
  Math.abs((created.body?.totalCost ?? 0) - expectedCost) < 0.01,
  `${created.body?.totalCost} против ${expectedCost}`,
);
record(
  "номер накладной записан во все строки",
  (created.body?.movements ?? []).every((movement) => movement.orderNumber === created.body?.movements?.[0]?.orderNumber),
  "номера строк разошлись",
);
record(
  "тип у всех строк — приход",
  (created.body?.movements ?? []).every((movement) => movement.type === "receipt"),
  "встретился не приход",
);

const afterFirst = await call("GET", "/api/products");
const stockAfter = new Map((afterFirst.body ?? []).map((item) => [item.id, item.currentStock]));
const stockOk = positions.every(
  (position) => stockAfter.get(position.productId) === before.get(position.productId) + position.quantity,
);
record(
  "остаток каждого товара вырос ровно на своё количество",
  stockOk,
  JSON.stringify(
    positions.map((position) => ({
      товар: position.productId,
      было: before.get(position.productId),
      стало: stockAfter.get(position.productId),
      ожидалось: before.get(position.productId) + position.quantity,
    })),
  )?.slice(0, 300),
);

console.log("\n=== 2. Один товар двумя строками — две партии ===");
const twice = stock[0];
const twoBatches = await call("POST", "/api/movements/bulk-receipt", {
  positions: [
    { productId: twice.id, quantity: 3, unitPrice: 100 },
    { productId: twice.id, quantity: 4, unitPrice: 150 },
  ],
});
record("обе строки одного товара проведены", twoBatches.status === 201, `статус ${twoBatches.status}`);
const sameProduct = (twoBatches.body?.movements ?? []).filter((movement) => movement.productId === twice.id);
record(
  "на один товар созданы две отдельные операции",
  sameProduct.length === 2 && sameProduct[0].id !== sameProduct[1].id,
  JSON.stringify(sameProduct.map((movement) => movement.id)),
);
record(
  "партии разные по цене",
  sameProduct[0]?.unitPrice === 100 && sameProduct[1]?.unitPrice === 150,
  JSON.stringify(sameProduct.map((movement) => movement.unitPrice)),
);
record(
  "у обеих партий есть остаток",
  sameProduct.every((movement) => (movement.remainingQuantity ?? 0) > 0),
  JSON.stringify(sameProduct.map((movement) => movement.remainingQuantity)),
);

console.log("\n=== 3. Ошибка в строке не проводит ничего ===");
// Снимок берём прямо перед попыткой, а не из начала проверки: к этому моменту остатки
// уже изменились предыдущими накладными, и сравнение с устаревшими значениями ругалось бы
// на нормальное поведение.
const beforeBad = await allStock();
const badLastRow = await call("POST", "/api/movements/bulk-receipt", {
  positions: [
    { productId: stock[0].id, quantity: 5, unitPrice: 100 },
    { productId: stock[1].id, quantity: 5, unitPrice: 100 },
    { productId: 999999999, quantity: 5, unitPrice: 100 },
  ],
});
record(
  "накладная с несуществующим товаром отклонена",
  badLastRow.status === 400,
  `статус ${badLastRow.status}: ${JSON.stringify(badLastRow.body)?.slice(0, 160)}`,
);
record(
  "в сообщении указана проблемная строка",
  /Строка 3/u.test(String(badLastRow.body?.error ?? "")),
  String(badLastRow.body?.error),
);
const afterBad = await allStock();
const unchanged = stock.slice(0, 2).every((item) => afterBad.get(item.id) === beforeBad.get(item.id));
record(
  "первые две строки НЕ проведены",
  unchanged,
  JSON.stringify(
    stock.slice(0, 2).map((item) => ({
      товар: item.id,
      было: beforeBad.get(item.id),
      стало: afterBad.get(item.id),
    })),
  ),
);

console.log("\n=== 4. Пустые и неверные значения ===");
const zeroQuantity = await call("POST", "/api/movements/bulk-receipt", {
  positions: [
    { productId: stock[0].id, quantity: 5, unitPrice: 100 },
    { productId: stock[1].id, quantity: 0, unitPrice: 100 },
  ],
});
record("нулевое количество отклонено", zeroQuantity.status === 400, `статус ${zeroQuantity.status}`);
const negativePrice = await call("POST", "/api/movements/bulk-receipt", {
  positions: [{ productId: stock[0].id, quantity: 5, unitPrice: -10 }],
});
record("отрицательная цена отклонена", negativePrice.status === 400, `статус ${negativePrice.status}`);
const empty = await call("POST", "/api/movements/bulk-receipt", { positions: [] });
record("пустая накладная отклонена", empty.status === 400, `статус ${empty.status}`);
const tooMany = await call("POST", "/api/movements/bulk-receipt", {
  positions: Array.from({ length: 51 }, (_, index) => ({
    productId: stock[0].id,
    quantity: 1,
    unitPrice: 100 + index,
  })),
});
record("накладная больше 50 строк отклонена", tooMany.status === 400, `статус ${tooMany.status}`);

const afterErrors = await allStock();
record(
  "после всех отклонённых попыток остатки не изменились",
  stock.slice(0, 3).every((item) => afterErrors.get(item.id) === beforeBad.get(item.id)),
  JSON.stringify(
    stock.slice(0, 3).map((item) => ({
      товар: item.id,
      до: beforeBad.get(item.id),
      после: afterErrors.get(item.id),
    })),
  ),
);

console.log("\n=== 5. Пометка «не в статистике» на всю накладную ===");
const excluded = await call("POST", "/api/movements/bulk-receipt", {
  positions: [{ productId: stock[2].id, quantity: 2, unitPrice: 50 }],
  excludeFromStats: true,
  reason: "Проверка: без статистики",
});
record("накладная с пометкой проведена", excluded.status === 201, `статус ${excluded.status}: ${JSON.stringify(excluded.body)?.slice(0, 160)}`);
record(
  "пометка попала во все строки",
  (excluded.body?.movements ?? []).every((movement) => movement.excludeFromStats === true),
  JSON.stringify((excluded.body?.movements ?? []).map((movement) => movement.excludeFromStats)),
);

console.log("\n=== 6. Отмена одной строки накладной ===");
// Отмена разрешена только для последнего движения товара, поэтому берём товар, которого
// больше не касаемся, и отменяем сразу — иначе проверка ругалась бы на законное правило.
const undoProduct = stock[5] ?? stock[stock.length - 1];
const undoable = await call("POST", "/api/movements/bulk-receipt", {
  positions: [
    { productId: undoProduct.id, quantity: 3, unitPrice: 90 },
    { productId: stock[4].id, quantity: 1, unitPrice: 70 },
  ],
});
const undoId = undoable.body?.movements?.[1]?.id;
record("накладная для отмены проведена", undoable.status === 201 && Boolean(undoId), `статус ${undoable.status}`);
const undo = await call("POST", `/api/movements/${undoId}/undo`, {});
record(
  "строку накладной можно отменить",
  undo.status === 200 || undo.status === 201,
  `статус ${undo.status}: ${JSON.stringify(undo.body)?.slice(0, 160)}`,
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
