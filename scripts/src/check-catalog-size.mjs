/**
 * Измеряет размер каталога, который уходит в подсказку ассистента.
 *
 * Каталог передаётся модели на каждой команде, поэтому его размер прямо влияет
 * на стоимость и на точность: чем больше лишнего, тем хуже модель находит нужное.
 *
 * Usage: node scripts/src/check-catalog-size.mjs
 */
import { signIn } from "./auth-helper.mjs";

const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const session = await signIn(api);
const products = await (
  await fetch(`${api}/api/products`, { headers: { cookie: session.cookieHeader } })
).json();

/** Прежний формат: полные ключи, все поля. */
const verbose = products.map((product) => ({
  id: product.id,
  name: product.name,
  aliases: product.aliases,
  category: product.category,
  unit: product.unit,
  stock: product.currentStock,
  minimum: product.minimumStock,
  purchasePrice: product.purchasePrice,
  markupPercent: product.markupPercent,
  salePrice: product.salePrice,
}));

/** Компактный формат: короткие ключи, без вычисляемых полей. */
const compact = products.map((product) => ({
  id: product.id,
  n: product.name,
  a: product.aliases,
  u: product.unit,
  s: product.currentStock,
  sp: product.salePrice,
}));

/**
 * То, что уходит в промпт после сжатия: полное описание товара модели нужно
 * только для выбора, а цены и остатки нужны, чтобы отвечать на вопросы о них.
 */
const compactWithoutAliases = compact.map(({ a: _a, ...rest }) => rest);

const size = (value) => JSON.stringify(value).length;

const verboseSize = size(verbose);
const compactSize = size(compact);

console.log(`товаров в каталоге: ${products.length}`);
console.log("");
console.log("формат                       символов   экономия");
console.log(`текущий (полные ключи)       ${String(verboseSize).padStart(8)}         —`);
console.log(
  `компактный (короткие ключи)  ${String(compactSize).padStart(8)}   ${String(
    Math.round((1 - compactSize / verboseSize) * 100),
  ).padStart(4)}%`,
);
console.log(
  `компактный без псевдонимов   ${String(size(compactWithoutAliases)).padStart(8)}   ${String(
    Math.round((1 - size(compactWithoutAliases) / verboseSize) * 100),
  ).padStart(4)}%`,
);
console.log("");

// Псевдонимы отбрасывать нельзя: именно по ним распознаются разговорные названия.
const aliasShare = size(compact) - size(compactWithoutAliases);
console.log(
  `псевдонимы занимают ${aliasShare} символов (${Math.round((aliasShare / compactSize) * 100)}% компактного каталога) — их надо оставить`,
);
console.log("");

const perProduct = Math.round(compactSize / Math.max(products.length, 1));
console.log(`в среднем на товар: ${perProduct} символов`);
for (const count of [50, 100, 200, 500]) {
  console.log(
    `  при ${String(count).padStart(3)} товарах компактный каталог: ~${String(
      Math.round((count * perProduct) / 1000),
    ).padStart(4)} тыс. символов`,
  );
}

// Проверяем, что компактный формат не теряет ничего нужного для выбора товара.
const requiredKeys = ["id", "n", "a", "u", "s", "sp"];
const missing = compact.filter((item) =>
  requiredKeys.some((key) => item[key] === undefined),
);
console.log("");
if (missing.length) {
  console.error(`ОШИБКА: у ${missing.length} товаров не хватает полей`);
  process.exit(1);
}
console.log("компактный формат содержит id, название, псевдонимы, единицу, остаток и цену продажи");
