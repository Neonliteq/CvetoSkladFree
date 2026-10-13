import assert from "node:assert/strict";
import test from "node:test";
import {
  catalogCandidates,
  coreName,
  formatInvoiceDraft,
  matchInvoiceLine,
  matchInvoiceLines,
  normalizeName,
  scoreCatalogItem,
  type CatalogItem,
} from "./invoice-context.ts";

const catalog: CatalogItem[] = [
  {
    id: 1,
    name: "Роза Эквадор красная",
    aliases: ["розы красные", "красная роза"],
    category: "Цветы",
    unit: "стебель",
    averagePrice: 95,
    currentStock: 300,
    markupPercent: 120,
    shelfLifeDays: 10,
    productType: "stock",
  },
  {
    id: 2,
    name: "Роза Кения белая",
    aliases: ["розы белые"],
    category: "Цветы",
    unit: "стебель",
    averagePrice: 88,
    currentStock: 150,
    markupPercent: 130,
    shelfLifeDays: 9,
    productType: "stock",
  },
  {
    id: 3,
    name: "Хризантема белая",
    aliases: ["хризантема"],
    category: "Цветы",
    unit: "шт",
    averagePrice: 62,
    currentStock: 120,
    markupPercent: 110,
    shelfLifeDays: 12,
    productType: "stock",
  },
  {
    id: 4,
    name: "Лента атласная пудровая",
    aliases: ["лента"],
    category: "Упаковка",
    unit: "м",
    averagePrice: 12,
    currentStock: 50,
    markupPercent: 150,
    shelfLifeDays: 0,
    productType: "stock",
  },
  {
    id: 5,
    name: "Букет «Утро»",
    aliases: [],
    category: "Букеты",
    unit: "шт",
    averagePrice: 900,
    currentStock: 2,
    markupPercent: 90,
    shelfLifeDays: 5,
    productType: "bouquet",
  },
];

test("strips variety, stem length and packaging from the printed name", () => {
  assert.equal(coreName("Роза Эквадор красная, Freedom, 60 см"), "роза эквадор красная");
  assert.equal(coreName("Лента атласная пудровая, 25 мм"), "лента атласная пудровая");
  assert.equal(coreName("Гипсофила белая, упаковка 10 веток"), "гипсофила белая");
  assert.equal(coreName("Бумага крафт, рулон 0,7×10 м"), "бумага крафт");
});

test("normalises ё, case and punctuation", () => {
  assert.equal(normalizeName("  РОЗА  Ёж,  50 см "), "роза еж 50 см");
});

test("matches the catalog product inside a verbose printed name", () => {
  const score = scoreCatalogItem("Роза Эквадор красная, Freedom, 60 см", catalog[0]);
  assert.ok(score > 0.9, `expected a confident match, got ${score}`);
});

test("recognises a configured alias printed on the document", () => {
  const candidates = catalogCandidates("Розы красные 60 см", catalog);
  assert.equal(candidates[0]?.product.id, 1);
});

test("does not confuse two similar roses", () => {
  const candidates = catalogCandidates("Роза Кения белая, Avalanche", catalog);
  assert.equal(candidates[0]?.product.id, 2);
  assert.ok(
    !candidates.some((candidate) => candidate.product.id === 1),
    "the red rose must not be offered for a white rose line",
  );
});

test("reports an unknown product instead of guessing", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Орхидея Фаленопсис белая", quantity: 10, unitPrice: 400 },
    catalog,
  });
  assert.equal(line.matchStatus, "unknown");
  assert.equal(line.productId, null);
  assert.equal(line.recommended, false);
  assert.match(line.issues.join(" "), /не найден/u);
});

test("flags a line as ambiguous when two products fit equally", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Роза", quantity: 100, unitPrice: 90 },
    catalog,
  });
  assert.equal(line.matchStatus, "ambiguous");
  assert.ok(line.candidates.length >= 2, "both roses should be offered");
  assert.equal(line.recommended, false);
});

test("accepts a selection the user made for an ambiguous line", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Роза", quantity: 100, unitPrice: 90 },
    catalog,
    selectedProductId: 2,
  });
  assert.equal(line.matchStatus, "matched");
  assert.equal(line.productId, 2);
  assert.equal(line.productName, "Роза Кения белая");
});

test("flags an unreadable quantity and price", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Хризантема белая", quantity: 0, unitPrice: 0 },
    catalog,
  });
  assert.equal(line.productId, 3);
  assert.equal(line.recommended, false);
  assert.match(line.issues.join(" "), /количество/u);
  assert.match(line.issues.join(" "), /цена/u);
});

test("flags a unit mismatch against the catalog", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Лента атласная пудровая", quantity: 100, unitPrice: 12, unit: "рулон" },
    catalog,
  });
  assert.match(line.issues.join(" "), /Единица/u);
});

test("flags a price far from the average purchase price", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Хризантема белая", quantity: 100, unitPrice: 500 },
    catalog,
  });
  assert.match(line.issues.join(" "), /отличается от средней/u);
});

test("matches every line of a realistic invoice", () => {
  const items = matchInvoiceLines({
    lines: [
      { rawName: "Роза Эквадор красная, Freedom, 60 см", quantity: 300, unitPrice: 92 },
      { rawName: "Роза Кения белая, Avalanche, 50 см", quantity: 200, unitPrice: 85.5 },
      { rawName: "Хризантема белая, Baltika", quantity: 150, unitPrice: 61 },
      { rawName: "Лента атласная пудровая, 25 мм", quantity: 100, unitPrice: 12.5 },
    ],
    catalog,
  });
  assert.deepEqual(
    items.map((item) => item.productId),
    [1, 2, 3, 4],
  );
  assert.ok(items.every((item) => item.recommended), "all four lines should be ready to post");
});

test("formats the draft with the document header and per-line outcome", () => {
  const items = matchInvoiceLines({
    lines: [
      { rawName: "Хризантема белая, Baltika", quantity: 150, unitPrice: 61 },
      { rawName: "Орхидея Фаленопсис", quantity: 5, unitPrice: 400 },
    ],
    catalog,
  });
  const text = formatInvoiceDraft({
    supplierName: "ООО «ЦветТорг»",
    invoiceNumber: "4712",
    invoiceDate: "2026-09-09",
    items,
  });
  assert.match(text, /ООО «ЦветТорг»/u);
  assert.match(text, /№ 4712/u);
  assert.match(text, /«Хризантема белая»/u);
  assert.match(text, /товар не найден/u);
  assert.match(text, /Готово к приходу: 1 из 2/u);
});

test("never offers a bouquet as a receipt target", () => {
  const candidates = catalogCandidates("Букет «Утро»", catalog);
  assert.equal(candidates[0]?.product.productType, "bouquet");
  const stockOnly = catalogCandidates(
    "Букет «Утро»",
    catalog.filter((item) => item.productType === "stock"),
  );
  assert.equal(stockOnly.length, 0);
});

test("prepares a new catalog entry from an unmatched line", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Орхидея Фаленопсис белая, 70 см", quantity: 10, unitPrice: 400, unit: "стебель" },
    catalog,
  });
  assert.equal(line.matchStatus, "unknown");
  // Stem length must not leak into the product name.
  assert.equal(line.suggestedName, "Орхидея фаленопсис белая");
  assert.equal(line.suggestedCategory, "Цветы");
  assert.equal(line.suggestedUnit, "стебель");
  assert.deepEqual(line.suggestedAliases, ["орхидея фаленопсис"]);
});

test("suggests category markup and shelf life from the catalog peers", () => {
  const flowers = matchInvoiceLine({
    line: { rawName: "Пион Sarah Bernhardt", quantity: 30, unitPrice: 220, unit: "стебель" },
    catalog,
  });
  assert.equal(flowers.suggestedCategory, "Цветы");
  assert.equal(flowers.suggestedMarkupPercent, 120);
  assert.equal(flowers.suggestedShelfLifeDays, 10);

  const packaging = matchInvoiceLine({
    line: { rawName: "Бумага тишью белая", quantity: 5, unitPrice: 300 },
    catalog,
  });
  assert.equal(packaging.suggestedCategory, "Упаковка");
  assert.equal(packaging.suggestedMarkupPercent, 150);
  assert.equal(packaging.suggestedShelfLifeDays, 0);
  assert.equal(packaging.suggestedUnit, "м");
});

test("leaves the category empty instead of guessing for unknown wording", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Сухоцвет лагурус зайцехвост", quantity: 50, unitPrice: 60 },
    catalog,
  });
  assert.equal(line.suggestedCategory, null);
  assert.equal(line.suggestedMarkupPercent, 0);
  assert.equal(line.suggestedUnit, "шт");
});

test("a matched line still carries the dialog defaults from its product", () => {
  const line = matchInvoiceLine({
    line: { rawName: "Роза Эквадор красная, Freedom, 60 см", quantity: 100, unitPrice: 90 },
    catalog,
  });
  assert.equal(line.matchStatus, "matched");
  assert.equal(line.suggestedCategory, "Цветы");
  assert.equal(line.suggestedMarkupPercent, 120);
  assert.equal(line.suggestedUnit, "стебель");
});
