/**
 * Разбор составной команды на отдельные операции.
 *
 * Модель умеет вызывать инструмент несколько раз за один ответ — по вызову на
 * позицию. Раньше это запрещалось (`getSingleFunctionToolCall` отклонял набор),
 * потому что набор применялся бы целиком и любая спорная позиция блокировала
 * остальные. Здесь набор разбирается построчно: однозначные позиции становятся
 * операциями, спорные — вопросами с вариантами выбора.
 */
import type { CatalogProduct } from "./assistant-context.ts";
import { bestCatalogMatches, stemsMatch, textStems } from "./assistant-context.ts";

export type PlannedOperation = {
  /** Номер позиции в команде пользователя. */
  index: number;
  /** Название, как его написал пользователь. */
  asked: string;
  /** Товар, выбранный моделью. */
  productId: number;
  productName: string;
  unit: string;
  type: "receipt" | "expense" | "writeoff" | "production_input";
  quantity: number;
  unitPrice?: number;
  saleUnitPrice?: number;
  markupPercent?: number;
  reason?: string;
};

export type ClarificationOption = {
  id: number;
  name: string;
  unit: string;
  stock: number;
};

export type Clarification = {
  /** Номер позиции в команде пользователя. */
  index: number;
  /** Название из команды, по которому нужен выбор. */
  asked: string;
  /** Варианты товаров, из которых выбирает пользователь. */
  options: ClarificationOption[];
  /** Количество из команды, чтобы после выбора не спрашивать снова. */
  quantity: number;
  type: PlannedOperation["type"];
  /** Пояснение, когда вариантов нет: позиция не распознана. */
  message?: string | null;
  /**
   * Выбранный товар. Появляется, когда пользователь ответил на вопрос — в
   * веб-интерфейсе кнопкой, в мессенджере номером или названием. `null` —
   * значение из сохранённого разбора: так его отдаёт схема API.
   */
  selectedProductId?: number | null;
};

export type PlanResult = {
  operations: PlannedOperation[];
  clarifications: Clarification[];
  /** Свободный текст модели, если она задала вопрос. */
  answer: string;
};

/**
 * Разговорные названия операций. Модель регулярно подставляет русское слово в
 * `operationType`, хотя инструмент объявляет английские значения: без перевода
 * позиция «Продажа 3 хризантемы» молча терялась бы.
 */
const MOVEMENT_TYPE_ALIASES: Record<string, PlannedOperation["type"]> = {
  receipt: "receipt",
  income: "receipt",
  arrival: "receipt",
  приход: "receipt",
  поступление: "receipt",
  закупка: "receipt",
  expense: "expense",
  sale: "expense",
  продажа: "expense",
  продали: "expense",
  расход: "expense",
  выдача: "expense",
  writeoff: "writeoff",
  "write-off": "writeoff",
  списание: "writeoff",
  списать: "writeoff",
  брак: "writeoff",
  production_input: "production_input",
  production: "production_input",
  сборка: "production_input",
  собрали: "production_input",
};

export type RawToolCall = {
  name: string;
  arguments: string;
};

/** Разбивает команду на позиции: «продажа 1 роза, 2 гвоздики и 3 ленты». */
export function splitCommandPositions(message: string): string[] {
  return message
    .split(/[,;\n]|\s+и\s+/iu)
    .map((position) => position.trim())
    .filter(Boolean);
}

/**
 * Вытаскивает название позиции из вызова инструмента.
 *
 * Модель обязана передать `productName` словами пользователя, но иногда
 * подставляет название из каталога. В этом случае название позиции берётся из
 * самой команды — по номеру позиции, чтобы «1 роза красная» не превратилась в
 * «Роза Эквадор красная» и не потеряла спорность.
 */
function askedNameOf(
  args: Record<string, unknown>,
  position: string | undefined,
): string {
  return productNameOf(position) || modelProductName(args);
}

/** Название товара, как его передала модель. */
function modelProductName(args: Record<string, unknown>): string {
  return typeof args.productName === "string" ? args.productName.trim() : "";
}

/** Отрезает от позиции команды действие и количество: «Продажа 3 розы» → «розы». */
function productNameOf(position: string | undefined): string {
  const text = (position ?? "").trim();
  if (!text) return "";
  const quantity = text.match(/\d+([.,]\d+)?/u);
  if (quantity && quantity.index !== undefined) {
    return text.slice(quantity.index + quantity[0].length).trim();
  }
  const withoutVerb = text.replace(/^[^\p{L}]*\p{L}*\s*/u, "").trim();
  return withoutVerb || text;
}

/** Убирает из позиции команды название, оставляя количество и действие. */
function quantityOf(position: string | undefined): number | undefined {
  const match = (position ?? "").match(/\d+([.,]\d+)?/u);
  if (!match) return undefined;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Похожа ли строка на позицию команды.
 *
 * «Покажи остатки» или «Что сегодня продали?» — не позиция: такая строка
 * остаётся ответом модели, а не вопросом о товаре.
 */
function looksLikeOperation(position: string): boolean {
  if (quantityOf(position) !== undefined) return true;
  return /(приход|поступлен|закуп|прода|продал|расход|выдач|списан|списать|брак|сборк|собрал|корректиров|пересчита|receipt|expense|writeoff|production)/iu
    .test(position);
}

/**
 * Превращает вызовы инструментов в план операций.
 *
 * Каждый вызов проверяется по каталогу: если название из команды подходит
 * нескольким товарам, позиция уходит в уточнение вместо применения — и только
 * она, остальные позиции набора не страдают.
 */
export function planFromToolCalls(
  calls: RawToolCall[],
  products: CatalogProduct[],
  message = "",
): PlanResult {
  const operations: PlannedOperation[] = [];
  const clarifications: Clarification[] = [];
  const positions = splitCommandPositions(message);
  const claimedPositions = new Set<number>();

  for (const [callIndex, call] of calls.entries()) {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(call.arguments) as Record<string, unknown>;
    } catch {
      continue;
    }

    const type = movementTypeOf(call.name, args);
    if (!type) continue;

    const positionIndex = locatePosition(callIndex, args, positions, claimedPositions);
    if (positionIndex !== undefined) claimedPositions.add(positionIndex);
    const position = positionIndex === undefined ? undefined : positions[positionIndex];

    const quantity = Number(args.quantity);
    const positionQuantity = quantityOf(position);
    const resolvedQuantity =
      Number.isFinite(quantity) && quantity > 0 ? quantity : positionQuantity;
    if (resolvedQuantity === undefined || resolvedQuantity <= 0) continue;

    const asked = askedNameOf(args, position) || "позиция без названия";
    const stockProducts = products.filter(
      (item) => !item.productType || item.productType === "stock",
    );
    // Спорность определяем по названию из команды, а не по выбору модели:
    // «роза красная» подходит нескольким товарам, и решать должен человек.
    const matches = bestCatalogMatches(asked, stockProducts);
    if (matches.length > 1) {
      clarifications.push({
        index: positionIndex ?? callIndex,
        asked,
        quantity: resolvedQuantity,
        type,
        // Все подходящие товары, а не первые несколько: интерфейс показывает
        // частые варианты кнопками, а остальные — выпадающим списком. Если
        // обрезать список здесь, нужный товар может в него не попасть.
        options: matches.map(({ product: option }) => ({
          id: option.id,
          name: option.name,
          unit: option.unit ?? "ед.",
          stock: option.currentStock ?? 0,
        })),
      });
      continue;
    }

    const productId = Number(args.productId);
    // Букеты не участвуют в складских операциях: их остаток считается из состава.
    // Фильтр применяется и к выбору товара, и к проверке спорности выше, иначе
    // букет прошёл бы как обычная позиция.
    const product = stockProducts.find((item) => item.id === productId);
    if (!product) continue;

    operations.push({
      index: positionIndex ?? callIndex,
      asked: asked || product.name,
      productId: product.id,
      productName: product.name,
      unit: product.unit ?? "ед.",
      type,
      quantity: resolvedQuantity,
      unitPrice: numberOrUndefined(args.unitPrice),
      saleUnitPrice: numberOrUndefined(args.saleUnitPrice),
      markupPercent: numberOrUndefined(args.markupPercent),
      reason: typeof args.reason === "string" ? args.reason : undefined,
    });
  }

  // Позиции, до которых модель не дошла, не теряются: по каждой из них
  // пользователь получает вопрос с вариантами, а не молчаливый пропуск.
  // Модель отвечает не на все позиции (в проверке на «2 гипсофилы, 1 роза» она
  // иногда возвращает только розу), поэтому пропущенная позиция остаётся в
  // разборе и без подходящих вариантов — её нужно назвать иначе.
  for (const [positionIndex, position] of positions.entries()) {
    if (claimedPositions.has(positionIndex)) continue;
    // Обычный вопрос («Покажи остатки») не превращается в позицию команды:
    // запасной вариант нужен только для строк, похожих на операцию.
    if (!looksLikeOperation(position)) continue;
    const asked = productNameOf(position);
    if (!asked) continue;
    const stockProducts = products.filter(
      (item) => !item.productType || item.productType === "stock",
    );
    const matches = bestCatalogMatches(asked, stockProducts);
    clarifications.push({
      index: positionIndex,
      asked,
      quantity: quantityOf(position) ?? 1,
      type: "expense",
      options: matches.map(({ product: option }) => ({
        id: option.id,
        name: option.name,
        unit: option.unit ?? "ед.",
        stock: option.currentStock ?? 0,
      })),
      ...(matches.length === 0
        ? {
            message:
              `Позицию «${position}» не удалось распознать в каталоге. ` +
              "Назовите товар точнее — по этой позиции склад не изменён.",
          }
        : {}),
    });
  }

  return { operations, clarifications, answer: "" };
}

/**
 * Находит позицию команды, к которой относится вызов инструмента.
 *
 * Сначала по названию, которое передала модель (сравнение по основам слов:
 * «Бумага крафт для букета» из каталога против «бумага крафт для букета» в
 * команде), затем — по порядку вызовов: модель отвечает по одному вызову на
 * позицию, поэтому порядок совпадает.
 */
function locatePosition(
  callIndex: number,
  args: Record<string, unknown>,
  positions: string[],
  claimed: Set<number>,
): number | undefined {
  const productName = modelProductName(args).toLocaleLowerCase("ru");
  if (productName) {
    const bySubstring = positions.findIndex(
      (position, index) =>
        !claimed.has(index) && position.toLocaleLowerCase("ru").includes(productName),
    );
    if (bySubstring >= 0) return bySubstring;
    const modelStems = textStems(productName);
    const byStems = positions.findIndex((position, index) => {
      if (claimed.has(index)) return false;
      const positionStems = textStems(productNameOf(position));
      return (
        positionStems.length > 0 &&
        positionStems.every((stem) => modelStems.some((other) => stemsMatch(stem, other)))
      );
    });
    if (byStems >= 0) return byStems;
  }
  if (callIndex < positions.length && !claimed.has(callIndex)) return callIndex;
  const free = positions.findIndex((_, index) => !claimed.has(index));
  return free >= 0 ? free : undefined;
}

function movementTypeOf(
  toolName: string,
  args: Record<string, unknown>,
): PlannedOperation["type"] | null {
  if (toolName === "create_receipt") return "receipt";
  if (toolName === "create_outflow") {
    const requested = String(args.operationType ?? "expense")
      .trim()
      .toLocaleLowerCase("ru");
    return MOVEMENT_TYPE_ALIASES[requested] ?? "expense";
  }
  return null;
}

const numberOrUndefined = (value: unknown): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Строка ответа для предпросмотра: «Продажа: 3 хризантемы алтай». */
export function describeOperation(operation: PlannedOperation): string {
  const verb =
    operation.type === "receipt"
      ? "Приход"
      : operation.type === "expense"
        ? "Продажа"
        : operation.type === "writeoff"
          ? "Списание"
          : "Сборка";
  const price = operation.type === "receipt" && operation.unitPrice !== undefined
    ? ` по ${operation.unitPrice} ₽`
    : "";
  return `${verb}: ${operation.quantity} ${operation.unit} «${operation.productName}»${price}`;
}

/** Текст уточнения с перечислением вариантов. */
export function describeClarification(clarification: Clarification): string {
  if (!clarification.options.length) {
    return (
      clarification.message ??
      `Позицию «${clarification.asked}» не удалось распознать. Назовите товар точнее.`
    );
  }
  const options = clarification.options.map((option) => `«${option.name}»`).join(", ");
  return `«${clarification.asked}» — подходит несколько товаров: ${options}. Какой выбрать?`;
}

