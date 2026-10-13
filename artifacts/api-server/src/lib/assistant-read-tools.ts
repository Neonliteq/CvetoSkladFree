/**
 * Инструменты чтения для ассистента.
 *
 * Раньше у ассистента были только инструменты изменения, поэтому на вопросы
 * «сколько роз осталось» и «что заканчивается» модель не могла ответить ничем,
 * кроме заглушки «Уточните, что нужно изменить». Чтение закрывает половину
 * обращений к складу и ничего не меняет в учёте.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db, movementsTable, productsTable } from "@workspace/db";

export const readTools = [
  {
    type: "function" as const,
    function: {
      name: "list_stock",
      description:
        "Показать остатки товаров. Использовать для вопросов «что на складе», «покажи остатки», «сколько чего есть»",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: {
            type: "string",
            description: "Часть названия товара, если нужен не весь список, а конкретные позиции",
          },
          onlyLow: {
            type: "boolean",
            description: "Показать только то, что на минимуме или ниже",
          },
          limit: { type: "number", description: "Сколько позиций показать, по умолчанию 20" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "get_product",
      description:
        "Подробности одного товара: остаток, цены, наценка, срок годности, последние операции. Использовать для вопросов «сколько стоит», «когда пришло», «какая наценка»",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productName"],
        properties: {
          productName: { type: "string", description: "Название товара, как его назвал пользователь" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_expiring",
      description:
        "Показать партии, у которых скоро истекает срок годности. Использовать для вопросов «что скоро испортится», «какие поставки портятся»",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          days: { type: "number", description: "Горизонт в днях, по умолчанию 7" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "list_recent_operations",
      description:
        "Показать последние операции склада. Использовать для вопросов «что делали», «последние операции», «что приходовали»",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "number", description: "Сколько операций показать, по умолчанию 10" },
          type: {
            type: "string",
            enum: ["receipt", "expense", "writeoff", "production_input"],
            description: "Показать операции только этого вида",
          },
        },
      },
    },
  },
];

const READ_TOOL_NAMES = new Set(readTools.map((tool) => tool.function.name));

export const isReadTool = (name: string) => READ_TOOL_NAMES.has(name);

/** Названия товаров для сопоставления без учёта регистра и окончаний. */
const coreWord = (value: string) =>
  value
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/[^a-zа-я0-9\s]/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);

/** Начало слова, а не любая позиция: «роз» не должно находить «прозрачная». */
const startsWord = (haystack: string, needle: string) => {
  let from = haystack.indexOf(needle);
  while (from !== -1) {
    if (from === 0 || /[\s-]/u.test(haystack[from - 1] ?? "")) return true;
    from = haystack.indexOf(needle, from + 1);
  }
  return false;
};

/** Ищет товар по названию: сверяет начало слов, а не вхождение подстроки. */
async function findProducts(name: string, limit = 5) {
  const words = coreWord(name);
  const products = await db.select().from(productsTable);

  const scored = products.map((product) => {
    const haystack = `${product.name} ${(product.aliases ?? []).join(" ")}`.toLocaleLowerCase("ru");
    let score = 0;
    for (const word of words) {
      if (word.length < 3) continue;
      // «хризантем» должно находить «Хризантема»: сверяем начало слова.
      const stem = word.slice(0, Math.max(4, word.length - 2));
      if (startsWord(haystack, stem)) score += 1;
    }
    return { product, score };
  });

  return scored
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.product);
}

const money = (value: number | null | undefined) =>
  value === null || value === undefined ? "—" : `${Math.round(value * 100) / 100} ₽`;

const dateOnly = (value: Date | string | null | undefined) =>
  value ? String(value).slice(0, 10) : "—";

const movementLabel: Record<string, string> = {
  receipt: "приход",
  expense: "продажа",
  writeoff: "списание",
  production_input: "в сборку",
  production_output: "из сборки",
  transfer: "перемещение",
};

/**
 * Слова, по которым видно, что нужен именно низкий остаток.
 *
 * Модель не всегда передаёт `onlyLow`, а вопрос «что заканчивается» без этого
 * признака возвращал весь склад или пустоту. Признак определяем по тексту
 * аргументов: они содержат исходную формулировку пользователя.
 */
const LOW_STOCK_HINTS = [
  "заканчива",
  "конча",
  "мало",
  "минимум",
  "пора заказ",
  "докупить",
  "дефицит",
];

/** Служебные слова вопроса: в них нет названия товара. */
const QUESTION_WORDS = new Set([
  "сколько", "осталось", "остаток", "остатки", "покажи", "показать", "что", "чего",
  "какие", "какой", "какая", "заканчивается", "заканчиваются", "кончается", "мало",
  "складе", "склад", "товар", "товары", "цена", "стоит", "стоимость", "наценка",
  "последние", "операции", "поставки", "скоро", "испортится", "портятся", "все", "всё",
]);

/** Выполняет инструмент чтения и возвращает текст, который увидит модель. */
export async function runReadTool(name: string, rawArguments: string): Promise<string> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArguments) as Record<string, unknown>;
  } catch {
    args = {};
  }

  if (name === "list_stock") {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    const onlyLow = args.onlyLow === true;
    const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 20;

    let products = await db.select().from(productsTable).orderBy(asc(productsTable.name));
    products = products.filter((product) => product.productType !== "bouquet");

    // Признак низкого остатка выводим и из самих аргументов: модель регулярно
    // не передаёт onlyLow, и вопрос «что заканчивается» возвращал весь склад.
    const argsText = rawArguments.toLocaleLowerCase("ru").replaceAll("ё", "е");
    const wantsLow = onlyLow || LOW_STOCK_HINTS.some((hint) => argsText.includes(hint));

    // Название товара ищем без служебных слов вопроса.
    const queryWords = coreWord(query).filter((word) => !QUESTION_WORDS.has(word));
    const cleanQuery = queryWords.join(" ");

    if (cleanQuery) {
      const found = await findProducts(cleanQuery, 50);
      const ids = new Set(found.map((product) => product.id));
      products = products.filter((product) => ids.has(product.id));
    }
    if (wantsLow) {
      products = products.filter(
        (product) => product.minimumStock > 0 && product.currentStock <= product.minimumStock,
      );
    }
    const shown = products.slice(0, limit);
    if (!shown.length) {
      if (wantsLow) return "Товаров на минимуме или ниже сейчас нет — запасов хватает.";
      return cleanQuery
        ? `Товары по запросу «${cleanQuery}» не найдены.`
        : "На складе нет подходящих товаров.";
    }
    return shown
      .map(
        (product) =>
          `${product.name}: ${product.currentStock} ${product.unit} (минимум ${product.minimumStock}), закупка ${money(product.purchasePrice)}, продажа ${money(product.salePrice)}`,
      )
      .join("\n");
  }

  if (name === "get_product") {
    const requested = typeof args.productName === "string" ? args.productName : "";
    const found = await findProducts(requested, 5);
    if (!found.length) return `Товар «${requested}» не найден в каталоге.`;
    if (found.length > 1) {
      return `Под запрос «${requested}» подходит несколько товаров, уточните какой: ${found
        .map((product) => product.name)
        .join(", ")}.`;
    }
    const product = found[0];
    const operations = await db
      .select()
      .from(movementsTable)
      .where(eq(movementsTable.productId, product.id))
      .orderBy(desc(movementsTable.createdAt))
      .limit(5);
    const history = operations
      .map(
        (movement) =>
          `${dateOnly(movement.createdAt)} ${movementLabel[movement.type] ?? movement.type}: ${movement.quantity} по ${money(movement.unitPrice)}`,
      )
      .join("; ");
    return [
      `${product.name} (${product.category}${product.variety ? `, ${product.variety}` : ""}${product.color ? `, ${product.color}` : ""})`,
      `остаток ${product.currentStock} ${product.unit}, минимум ${product.minimumStock}`,
      `закупка ${money(product.purchasePrice)}, средняя ${money(product.averagePrice)}, наценка ${product.markupPercent}%, продажа ${money(product.salePrice)}`,
      `срок годности ${product.shelfLifeDays} дн.`,
      history ? `последние операции: ${history}` : "операций пока нет",
    ].join("\n");
  }

  if (name === "list_expiring") {
    const days = Number.isFinite(Number(args.days)) ? Number(args.days) : 7;
    const until = new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);
    const today = new Date().toISOString().slice(0, 10);
    const batches = await db
      .select()
      .from(movementsTable)
      .where(
        and(
          inArray(movementsTable.type, ["receipt", "production_output"]),
          sql`${movementsTable.remainingQuantity} > 0`,
          lte(movementsTable.expiresAt, until),
          gte(movementsTable.expiresAt, today),
        ),
      )
      .orderBy(asc(movementsTable.expiresAt))
      .limit(50);
    if (!batches.length) return `Партий со сроком до ${until} нет.`;
    return batches
      .map((batch) => {
        const daysLeft = Math.ceil(
          (new Date(`${String(batch.expiresAt).slice(0, 10)}T12:00:00Z`).getTime() - Date.now()) /
            86400000,
        );
        return `${batch.productName}: остаток ${batch.remainingQuantity}, срок ${dateOnly(batch.expiresAt)} (через ${daysLeft} дн.)`;
      })
      .join("\n");
  }

  if (name === "list_recent_operations") {
    const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : 10;
    const type = typeof args.type === "string" ? args.type : null;
    const rows = await db
      .select()
      .from(movementsTable)
      .where(type ? eq(movementsTable.type, type as never) : sql`true`)
      .orderBy(desc(movementsTable.createdAt))
      .limit(limit);
    if (!rows.length) return "Операций нет.";
    return rows
      .map(
        (movement) =>
          `${dateOnly(movement.createdAt)} ${movementLabel[movement.type] ?? movement.type}: ${movement.productName}, ${movement.quantity} по ${money(movement.unitPrice)}`,
      )
      .join("\n");
  }

  return "Неизвестный инструмент чтения.";
}
