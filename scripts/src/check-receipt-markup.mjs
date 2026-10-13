/**
 * Проверяет правку наценки на уже принятой поставке.
 *
 * Usage: node scripts/src/check-receipt-markup.mjs
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
    parsed = text.slice(0, 120);
  }
  return { status: response.status, body: parsed };
};

console.log("=== 1. Берём товар с приходом ===");
const products = await call("GET", "/api/products");
const product = (products.body ?? []).find((item) => item.productType === "stock" && item.currentStock > 0);
if (!product) {
  console.error("Нет товара с остатком — проверку невозможно выполнить");
  process.exit(1);
}
console.log(
  `  товар: ${product.name}, наценка ${product.markupPercent}%, цена продажи ${product.salePrice}, средняя закупка ${product.averagePrice}`,
);

const receipts = await call("GET", `/api/products/${product.id}/receipts`);
const receipt = (receipts.body ?? [])[0];
if (!receipt) {
  console.error("У товара нет приходов");
  process.exit(1);
}
console.log(`  приход №${receipt.id}: ${receipt.quantity} по ${receipt.unitPrice}`);

console.log("\n=== 2. Приход отдаёт текущую наценку ===");
record(
  "в карточке прихода есть наценка",
  typeof receipt.markupPercent === "number",
  `markupPercent=${receipt.markupPercent}`,
);
record(
  "наценка прихода совпадает с наценкой товара",
  receipt.markupPercent === product.markupPercent,
  `приход ${receipt.markupPercent} против товара ${product.markupPercent}`,
);

console.log("\n=== 3. Меняем наценку на 55% ===");
const newMarkup = product.markupPercent === 55 ? 60 : 55;
const update = await call("PATCH", `/api/movements/${receipt.id}/receipt`, {
  markupPercent: newMarkup,
});
record("запрос прошёл", update.status === 200, `статус ${update.status} ${JSON.stringify(update.body).slice(0, 90)}`);

const after = (await call("GET", "/api/products")).body?.find((item) => item.id === product.id);
record("наценка товара изменилась", after?.markupPercent === newMarkup, `${after?.markupPercent} вместо ${newMarkup}`);

const expectedSale = Math.round(after.averagePrice * (1 + newMarkup / 100) * 100) / 100;
record(
  "цена продажи пересчитана от средней закупки",
  Math.abs((after?.salePrice ?? 0) - expectedSale) < 0.02,
  `получено ${after?.salePrice}, ожидалось ${expectedSale}`,
);
record(
  "цена продажи изменилась по сравнению с прежней",
  after?.salePrice !== product.salePrice,
  `${product.salePrice} → ${after?.salePrice}`,
);

const receiptAfter = (await call("GET", `/api/products/${product.id}/receipts`)).body?.[0];
record(
  "карточка прихода показывает новую наценку",
  receiptAfter?.markupPercent === newMarkup,
  `получено ${receiptAfter?.markupPercent}`,
);

console.log("\n=== 4. Прочие поля прихода не сломались ===");
record("количество сохранилось", receiptAfter?.quantity === receipt.quantity, `${receiptAfter?.quantity}`);
record("цена закупки сохранилась", receiptAfter?.unitPrice === receipt.unitPrice, `${receiptAfter?.unitPrice}`);
record("дата прихода сохранилась", Boolean(receiptAfter?.batchArrivalDate), receiptAfter?.batchArrivalDate);

console.log("\n=== 5. Наценка влияет на все приходы позиции ===");
const allSame = (await call("GET", `/api/products/${product.id}/receipts`)).body?.every(
  (item) => item.markupPercent === newMarkup,
);
record("у всех приходов товара одна наценка", Boolean(allSame), "");

console.log("\n=== 6. Проверки ввода ===");
const negative = await call("PATCH", `/api/movements/${receipt.id}/receipt`, { markupPercent: -5 });
record("отрицательная наценка отклонена", negative.status === 400, `статус ${negative.status}`);

const tooBig = await call("PATCH", `/api/movements/${receipt.id}/receipt`, { markupPercent: 5000 });
record("слишком большая наценка отклонена", tooBig.status === 400, `статус ${tooBig.status}`);

console.log("\n=== 7. Возвращаем прежнюю наценку ===");
const restore = await call("PATCH", `/api/movements/${receipt.id}/receipt`, {
  markupPercent: product.markupPercent,
});
const restored = (await call("GET", "/api/products")).body?.find((item) => item.id === product.id);
record("наценка восстановлена", restore.status === 200 && restored?.markupPercent === product.markupPercent, `${restored?.markupPercent}`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
