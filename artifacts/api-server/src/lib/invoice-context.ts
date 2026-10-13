/**
 * Matches invoice lines recognised from a photo against the product catalog.
 *
 * The vision model is told to copy the printed name verbatim, so lines carry
 * noise that the catalog never has: variety, stem length, packaging size,
 * supplier article numbers. Matching therefore works on a normalised "core"
 * name, and every line ends up in exactly one of three states:
 *
 *   matched   — one catalog product owns the line, it can be posted as is
 *   ambiguous — several products are equally good candidates, the user picks
 *   unknown   — nothing in the catalog fits, the user must create the product
 *
 * The module is deliberately free of database access so the rules stay unit
 * testable; callers pass the catalog in.
 */

export type CatalogItem = {
  id: number;
  name: string;
  aliases: string[];
  category: string;
  unit: string;
  averagePrice: number;
  currentStock: number;
  markupPercent: number;
  shelfLifeDays: number;
  productType: string;
};

export type RecognisedLine = {
  rawName: string;
  quantity: number;
  unitPrice: number;
  unit?: string | null;
};

export type MatchStatus = "matched" | "unknown" | "ambiguous";

export type MatchedLine = {
  rawName: string;
  quantity: number;
  unitPrice: number;
  unit: string | null;
  productId: number | null;
  productName: string | null;
  matchStatus: MatchStatus;
  candidates: Array<{ productId: number; productName: string }>;
  recommended: boolean;
  issues: string[];
  suggestedName: string;
  suggestedAliases: string[];
  suggestedCategory: string | null;
  suggestedUnit: string;
  suggestedMarkupPercent: number;
  suggestedShelfLifeDays: number;
};

const noisePatterns: RegExp[] = [
  // "60 см", "0,7×10 м", "25 мм", "50см"
  /\b\d+(?:[.,]\d+)?\s*(?:см|мм|м)\b/giu,
  // "упаковка 10 веток", "10 шт в упаковке"
  /\b(?:упаковка|упак|пачка|рулон|букет)\s*\d+\s*[a-zа-я.]*/giu,
  /\b\d+\s*(?:шт|веток|ветки|стебл\w*)\b/giu,
  // "25 мм", "0,7×10"
  /\b\d+(?:[.,]\d+)?\s*[×x]\s*\d+(?:[.,]\d+)?\b/giu,
  // supplier article numbers
  /\b(?:арт|артикул)\.?\s*[a-zа-я0-9-]+/giu,
];

/** Normalises a name for comparison: lowercase, ё→е, single spaces, no punctuation. */
export function normalizeName(value: string): string {
  return value
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

/**
 * Strips packaging/size noise and keeps the leading words of the printed name —
 * the part that identifies the product rather than its delivery format.
 * "Роза Эквадор красная, Freedom, 60 см" → "роза эквадор красная"
 */
export function coreName(value: string): string {
  let text = value;
  for (const pattern of noisePatterns) text = text.replace(pattern, " ");
  const beforeComma = text.split(/[,;(]/u)[0] ?? text;
  const leading = beforeComma.trim().length >= 3 ? beforeComma : text;
  return normalizeName(leading);
}

function tokenSet(value: string): Set<string> {
  return new Set(coreName(value).split(" ").filter((token) => token.length >= 2));
}

function coverage(source: string, target: string): number {
  const sourceTokens = tokenSet(source);
  const targetTokens = tokenSet(target);
  if (!sourceTokens.size || !targetTokens.size) return 0;
  let hits = 0;
  for (const token of targetTokens) if (sourceTokens.has(token)) hits += 1;
  return hits / targetTokens.size;
}

/**
 * Scores every catalog product against the printed line name on a 0..1 scale.
 * Identifiers are compared on the core name only, so a long printed name does
 * not dilute the score of the product it belongs to.
 */
export function scoreCatalogItem(lineName: string, item: CatalogItem): number {
  const lineCore = coreName(lineName);
  const lineNormalised = normalizeName(lineName);
  if (!lineCore) return 0;

  const identifiers = [item.name, ...item.aliases];
  let best = 0;
  for (const identifier of identifiers) {
    const identifierCore = coreName(identifier);
    if (!identifierCore) continue;
    if (identifierCore === lineCore) {
      best = Math.max(best, 1);
      continue;
    }
    if (normalizeName(identifier) === lineNormalised) {
      best = Math.max(best, 0.98);
      continue;
    }
    if (lineCore.startsWith(identifierCore) || identifierCore.startsWith(lineCore)) {
      // Prefix match: the printed name is a superset of the catalog name.
      const shorter = Math.min(lineCore.length, identifierCore.length);
      const longer = Math.max(lineCore.length, identifierCore.length);
      best = Math.max(best, 0.9 + 0.08 * (shorter / longer));
      continue;
    }
    const forward = coverage(lineCore, identifierCore);
    const backward = coverage(identifierCore, lineCore);
    if (forward >= 0.6 || backward >= 0.6) {
      best = Math.max(best, 0.55 + 0.3 * Math.max(forward, backward));
    }
  }
  return best;
}

/** Catalog candidates for a printed line name, best first. */
export function catalogCandidates(
  lineName: string,
  catalog: CatalogItem[],
  limit = 4,
): Array<{ product: CatalogItem; score: number }> {
  return catalog
    .map((product) => ({ product, score: scoreCatalogItem(lineName, product) }))
    .filter((candidate) => candidate.score >= 0.7)
    .sort((left, right) => right.score - left.score || left.product.name.localeCompare(right.product.name, "ru"))
    .slice(0, limit);
}

/** A score this close to the best one makes the choice genuinely ambiguous. */
const AMBIGUITY_MARGIN = 0.05;

/**
 * Category guess for a product that is not in the catalog yet.
 *
 * Deliberately keyword-based and conservative: a wrong category is easy for the
 * user to fix in the dialog, but guessing "Цветы" for a roll of ribbon would
 * silently distort the category analytics. `null` means "ask the user".
 */
const categoryKeywords: Array<{ category: string; patterns: RegExp }> = [
  { category: "Упаковка", patterns: /лент|бумаг|пленк|плёнк|упаков|крафт|сетк|флористическ\w* губк/iu },
  { category: "Коробки", patterns: /коробк|бокс|шкатулк/iu },
  { category: "Расходники", patterns: /шпагат|оазис|пиафлор|проволок|скотч|булавк|держател|шпильк|джут/iu },
  { category: "Зелень", patterns: /эвкалипт|рускус|рускус|салал|фисташк|зелень|папоротник|аспарагус|гиперрикум|берграсс|лист/iu },
  {
    category: "Цветы",
    patterns:
      /роз|тюльпан|хризантем|гвоздик|эустом|лизиантус|гипсофил|пион|гербер|лили|орхиде|ирис|фрези|альстромер|ромашк|маргаритк|гортензи|антуриум|дельфиниум|лаванд|подсолнух|георгин|астр|сирень|мимоз|нарцисс|ирисы|крокус|мускари|тюльпаны/iu,
  },
];

function suggestCategory(rawName: string): string | null {
  for (const { category, patterns } of categoryKeywords) {
    if (patterns.test(rawName)) return category;
  }
  return null;
}

/** Typical values for a category, taken from the catalog itself. */
function categoryDefaults(catalog: CatalogItem[], category: string | null) {
  if (!category) return null;
  const peers = catalog.filter((item) => item.category === category);
  if (!peers.length) return null;
  const typical = (values: number[]) => {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  };
  return {
    markupPercent: typical(peers.map((item) => item.markupPercent ?? 0)),
    shelfLifeDays: typical(peers.map((item) => item.shelfLifeDays ?? 0)),
  };
}

const unitDefaults: Record<string, string> = {
  Цветы: "стебель",
  Зелень: "упак.",
  Упаковка: "м",
  Коробки: "шт",
  Расходники: "шт",
};

/** Words that carry no product identity and must not become aliases. */
const keywordNoise = /^(?:ооо|ип|зао|ао)$/iu;

/**
 * A shorter name the user is likely to type later. With extra words in the
 * document ("Орхидея Фаленопсис белая") the alias is the species, otherwise it
 * is the first words of the name itself ("Роза Эквадор").
 */
function suggestAliases(rawName: string, core: string): string[] {
  const coreWords = core.split(" ").filter(Boolean);
  const tokens = normalizeName(rawName)
    .split(" ")
    .filter((token) => token.length >= 3 && !keywordNoise.test(token));
  const coreTokens = new Set(coreWords);
  const rest = tokens.filter((token) => !coreTokens.has(token));

  const alias = rest.length
    ? [coreWords[0], ...rest.slice(0, 2)].join(" ").trim()
    : coreWords.slice(0, 2).join(" ").trim();

  return alias && normalizeName(alias) !== core ? [alias] : [];
}

/**
 * Turns one recognised line plus the model's optional product choice into the
 * line the user reviews. Quantities and prices are validated here, not by the
 * model: a document may legitimately contain a zero price, and it must be
 * visible in the draft instead of silently posted.
 */
export function matchInvoiceLine(input: {
  line: RecognisedLine;
  catalog: CatalogItem[];
  selectedProductId?: number | null;
}): MatchedLine {
  const { line, catalog } = input;
  const issues: string[] = [];
  const candidates = catalogCandidates(line.rawName, catalog);

  const quantityValid = Number.isFinite(line.quantity) && line.quantity > 0;
  // A zero price in a delivery note means the column could not be read, not
  // that the goods were free.
  const priceValid = Number.isFinite(line.unitPrice) && line.unitPrice > 0;
  if (!quantityValid) issues.push("Не читается количество — укажите вручную");
  if (!priceValid) issues.push("Не читается цена — укажите вручную");

  const selected = input.selectedProductId
    ? catalog.find((item) => item.id === input.selectedProductId)
    : undefined;
  const bestScore = candidates[0]?.score ?? 0;
  const tied = candidates.filter((candidate) => bestScore - candidate.score < AMBIGUITY_MARGIN);

  let product: CatalogItem | undefined;
  let matchStatus: MatchStatus;
  if (selected && (candidates.some((candidate) => candidate.product.id === selected.id) || !candidates.length)) {
    product = selected;
    matchStatus = "matched";
  } else if (tied.length === 1) {
    product = tied[0].product;
    matchStatus = "matched";
  } else if (tied.length > 1) {
    matchStatus = "ambiguous";
    issues.push(
      `Подходит несколько товаров: ${tied
        .map((candidate) => `«${candidate.product.name}»`)
        .join(", ")}`,
    );
  } else {
    matchStatus = "unknown";
    issues.push("Товар не найден в каталоге — создайте его и повторите распознавание");
  }

  if (product && line.unit && normalizeName(line.unit) !== normalizeName(product.unit)) {
    issues.push(`Единица в документе «${line.unit}», в каталоге «${product.unit}»`);
  }
  if (
    product &&
    priceValid &&
    product.averagePrice > 0 &&
    line.unitPrice > 0 &&
    (line.unitPrice > product.averagePrice * 3 || line.unitPrice < product.averagePrice / 3)
  ) {
    issues.push(
      `Цена отличается от средней закупки (${product.averagePrice.toFixed(2)} ₽)`,
    );
  }

  const candidatesForUser = tied.length
    ? tied.map((candidate) => ({
        productId: candidate.product.id,
        productName: candidate.product.name,
      }))
    : candidates.map((candidate) => ({
        productId: candidate.product.id,
        productName: candidate.product.name,
      }));

  // What a new catalog entry would look like, so the user can create it from the
  // invoice line without retyping the document.
  const core = coreName(line.rawName);
  const suggestedName = core
    ? core.charAt(0).toLocaleUpperCase("ru") + core.slice(1)
    : line.rawName.trim();
  const suggestedCategory = product?.category ?? suggestCategory(line.rawName);
  const defaults = product
    ? { markupPercent: product.markupPercent ?? 0, shelfLifeDays: product.shelfLifeDays ?? 0 }
    : categoryDefaults(catalog, suggestedCategory);

  return {
    rawName: line.rawName,
    quantity: quantityValid ? line.quantity : 0,
    unitPrice: priceValid ? line.unitPrice : 0,
    unit: line.unit ?? product?.unit ?? null,
    productId: product?.id ?? null,
    productName: product?.name ?? null,
    matchStatus,
    candidates: matchStatus === "matched" ? [] : candidatesForUser,
    recommended: matchStatus === "matched" && quantityValid && priceValid,
    issues,
    suggestedName,
    suggestedAliases: suggestAliases(line.rawName, core),
    suggestedCategory,
    suggestedUnit:
      line.unit?.trim() || product?.unit || unitDefaults[suggestedCategory ?? ""] || "шт",
    suggestedMarkupPercent: defaults?.markupPercent ?? 0,
    suggestedShelfLifeDays: defaults?.shelfLifeDays ?? 0,
  };
}

export function matchInvoiceLines(input: {
  lines: RecognisedLine[];
  catalog: CatalogItem[];
  selections?: Array<{ index: number; productId: number }>;
}): MatchedLine[] {
  const selectionByIndex = new Map(
    (input.selections ?? []).map((selection) => [selection.index, selection.productId]),
  );
  return input.lines.map((line, index) =>
    matchInvoiceLine({
      line,
      catalog: input.catalog,
      selectedProductId: selectionByIndex.get(index) ?? null,
    }),
  );
}

/** Human-readable draft shown in the assistant conversation. */
export function formatInvoiceDraft(input: {
  supplierName: string | null;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  items: MatchedLine[];
}): string {
  const header = [
    "Накладная распознана.",
    input.supplierName ? `Поставщик: ${input.supplierName}` : null,
    input.invoiceNumber ? `Документ № ${input.invoiceNumber}` : null,
    input.invoiceDate ? `Дата: ${input.invoiceDate}` : null,
  ].filter(Boolean);

  const lines = input.items.map((item, index) => {
    const position = `${index + 1}. ${item.rawName} — ${item.quantity} × ${item.unitPrice} ₽`;
    if (item.matchStatus === "matched") {
      return `${position} → «${item.productName}»`;
    }
    if (item.matchStatus === "ambiguous") {
      return `${position} → уточните товар: ${item.candidates
        .map((candidate) => candidate.productName)
        .join(" / ")}`;
    }
    return `${position} → товар не найден в каталоге`;
  });

  const ready = input.items.filter((item) => item.recommended).length;
  const footer =
    ready === input.items.length
      ? "Все позиции сопоставлены. Проверьте и подтвердите приход."
      : `Готово к приходу: ${ready} из ${input.items.length}. Уточните отмеченные позиции.`;

  return [...header, "", ...lines, "", footer].join("\n");
}
