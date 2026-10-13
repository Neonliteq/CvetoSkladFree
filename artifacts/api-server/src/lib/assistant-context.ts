type ConversationMessage = {
  role: string;
  content: string;
};

type FunctionToolCall = {
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type CatalogProduct = {
  id: number;
  name: string;
  aliases?: string[];
  variety?: string | null;
  color?: string | null;
  productType?: string;
  /** Заполняются, когда товар приходит из полной записи каталога. */
  unit?: string;
  currentStock?: number;
};

const russianEndings = [
  "иями", "ями", "ами", "ого", "ему", "ыми", "ими", "ую", "юю",
  "ая", "яя", "ое", "ее", "ый", "ий", "ой", "ов", "ев", "ей",
  "ам", "ям", "ах", "ях", "ом", "ем", "ы", "и", "а", "я", "у",
  "ю", "е", "о",
];

function wordStem(word: string) {
  if (word.length <= 3) return word;
  const ending = russianEndings.find(
    (candidate) => word.endsWith(candidate) && word.length - candidate.length >= 3,
  );
  return ending ? word.slice(0, -ending.length) : word;
}

/** Основы слов текста: «Бумага крафт» и «бумагу крафт» дают одни и те же. */
export function textStems(value: string) {
  return value
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .match(/[a-zа-я]+/giu)
    ?.map(wordStem)
    .filter((word) => word.length >= 3) ?? [];
}

function editDistance(left: string, right: string) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

/**
 * Сравнивает основы слов.
 *
 * Отсечение окончаний режет разные слова по-разному: «хризантем» (из команды)
 * даёт основу «хризант», а «Хризантема» — «хризантем», и точного равенства нет.
 * Поэтому короче слово считается совпавшим, если оно — начало длинного И само
 * не короче пяти букв: «хризант» находит «хризантем», а короткое «роз» не
 * цепляется за «розовая» в «Эустома розовая».
 */
export function stemsMatch(left: string, right: string) {
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && editDistance(left, right) <= 1) return true;
  // Совпадение по началу слова, а не по любой позиции: «хризант» — начало
  // «хризантем», поэтому находится, а «роз» в «прозрачная» началом слова не
  // является и не подходит.
  const startsWord = (haystack: string, needle: string) => {
    let from = haystack.indexOf(needle);
    while (from !== -1) {
      if (from === 0 || /[\s-]/u.test(haystack[from - 1] ?? "")) return true;
      from = haystack.indexOf(needle, from + 1);
    }
    return false;
  };
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return shorter.length >= 5 && longer.length - shorter.length >= 2 && startsWord(longer, shorter);
}

function productStems(product: CatalogProduct) {
  return new Set(textStems(
    [product.name, product.variety, product.color, ...(product.aliases ?? [])]
      .filter(Boolean)
      .join(" "),
  ));
}

function normalizedIdentity(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/gu, " ");
}

export function bestCatalogMatches(text: string, products: CatalogProduct[]) {
  const normalizedText = normalizedIdentity(text);
  const exactAliasMatches = products
    .filter((product) =>
      product.aliases?.some((alias) => normalizedIdentity(alias) === normalizedText),
    )
    .map((product) => ({ product, matchedIdentities: Number.MAX_SAFE_INTEGER }));
  if (exactAliasMatches.length) return exactAliasMatches;

  const sourceStems = textStems(text);
  const scored = products.map((product) => {
    const identities = productStems(product);
    const matchedIdentities = [...identities].filter((identity) =>
      sourceStems.some((sourceStem) => stemsMatch(identity, sourceStem)),
    ).length;
    return { product, matchedIdentities };
  });
  const bestScore = Math.max(0, ...scored.map(({ matchedIdentities }) => matchedIdentities));
  return bestScore === 0
    ? []
    : scored.filter(({ matchedIdentities }) => matchedIdentities === bestScore);
}

function ambiguousProductMessage(
  matches: Array<{ product: CatalogProduct }>,
) {
  const variants = matches
    .slice(0, 4)
    .map(({ product }) => `«${product.name}»`)
    .join(", ");
  return `Найдено несколько товаров: ${variants}. Уточните, какой выбрать — склад не изменён.`;
}

export class AssistantProductSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssistantProductSelectionError";
  }
}

export function assertAssistantProductSelection(input: {
  selectedProductId: number;
  requestedProductName: unknown;
  currentMessage: string;
  recentUserMessages?: string[];
  recentConversationMessages?: ConversationMessage[];
  products: CatalogProduct[];
}) {
  const requestedName =
    typeof input.requestedProductName === "string"
      ? input.requestedProductName.trim()
      : "";
  if (!requestedName) {
    throw new AssistantProductSelectionError(
      "Уточните точное название товара — склад не изменён.",
    );
  }

  const stockProducts = input.products.filter(
    (product) => !product.productType || product.productType === "stock",
  );
  const requestedMatches = bestCatalogMatches(requestedName, stockProducts);
  if (
    requestedMatches.length === 0 ||
    !requestedMatches.some(({ product }) => product.id === input.selectedProductId)
  ) {
    throw new AssistantProductSelectionError(
      `Ассистент выбрал товар, не соответствующий названию «${requestedName}». Уточните название — склад не изменён.`,
    );
  }

  let commandMatches = bestCatalogMatches(input.currentMessage, stockProducts);
  if (commandMatches.length > 1) {
    throw new AssistantProductSelectionError(
      ambiguousProductMessage(commandMatches),
    );
  }

  if (commandMatches.length === 0) {
    const contextMessages = input.recentConversationMessages ??
      (input.recentUserMessages ?? []).map((content) => ({ role: "user", content }));
    const isAnaphoric =
      /(^|\s)(этот|эта|это|эти|его|ее|её|их|ещ[её]|столько же|такой же|тот же)(\s|$)/iu
        .test(input.currentMessage);
    const previousMessage = contextMessages[0];
    const isClarificationAnswer =
      previousMessage?.role === "assistant" &&
      (/[?？]\s*$/u.test(previousMessage.content) ||
        /\b(уточните|сколько|какой|какая|какие|который|цена|цене)\b/iu
          .test(previousMessage.content));
    if (!isAnaphoric && !isClarificationAnswer) {
      throw new AssistantProductSelectionError(
        "Не удалось однозначно определить товар из текущей команды. Уточните название — склад не изменён.",
      );
    }
    for (const message of contextMessages) {
      const historicalMatches = bestCatalogMatches(message.content, stockProducts);
      if (historicalMatches.length > 1) {
        throw new AssistantProductSelectionError(
          ambiguousProductMessage(historicalMatches),
        );
      }
      if (historicalMatches.length === 1) {
        commandMatches = historicalMatches;
        break;
      }
    }
  }

  if (commandMatches.length === 0) {
    throw new AssistantProductSelectionError(
      "Не удалось определить товар из контекста. Уточните точное название — склад не изменён.",
    );
  }
  if (commandMatches[0].product.id !== input.selectedProductId) {
    throw new AssistantProductSelectionError(
      `Команда относится к товару «${commandMatches[0].product.name}», а не к выбранному ассистентом товару. Повторите операцию — склад не изменён.`,
    );
  }

  return commandMatches[0].product;
}

export function assertAssistantReceiptSelection(input: {
  selectedMovementId: number;
  movementProductId: number;
  movementProductName: string;
  requestedProductName: unknown;
  currentMessage: string;
  recentConversationMessages?: ConversationMessage[];
  latestReceiptId?: number;
  products: CatalogProduct[];
}) {
  const explicitIds = [...input.currentMessage.matchAll(
    /(?:приход(?:а|у|ом)?\s*(?:№|#)?\s*|[№#]\s*)(\d+)/giu,
  )].map((match) => Number(match[1]));
  if (explicitIds.length > 0) {
    const uniqueIds = [...new Set(explicitIds)];
    if (uniqueIds.length === 1 && uniqueIds[0] === input.selectedMovementId) return;
    throw new AssistantProductSelectionError(
      "Ассистент выбрал другой номер прихода. Уточните номер — склад не изменён.",
    );
  }

  if (/последн(?:ий|его|ему|ем)\s+приход/iu.test(input.currentMessage)) {
    if (input.latestReceiptId === input.selectedMovementId) return;
    throw new AssistantProductSelectionError(
      "Ассистент выбрал не последний приход. Уточните номер прихода — склад не изменён.",
    );
  }

  assertAssistantProductSelection({
    selectedProductId: input.movementProductId,
    requestedProductName:
      typeof input.requestedProductName === "string" && input.requestedProductName.trim()
        ? input.requestedProductName
        : input.movementProductName,
    currentMessage: input.currentMessage,
    recentConversationMessages: input.recentConversationMessages,
    products: input.products,
  });
}

export function buildConversationMessages(
  recentMessagesNewestFirst: ConversationMessage[],
): ConversationMessage[] {
  return [...recentMessagesNewestFirst].reverse();
}

export function getSingleFunctionToolCall(
  toolCalls: Array<FunctionToolCall | { type: string }> | undefined,
): FunctionToolCall | undefined {
  if (!toolCalls?.length) return undefined;
  if (toolCalls.length !== 1 || toolCalls[0]?.type !== "function") {
    throw new Error(
      "Ассистент предложил несколько операций. Уточните команду, склад не изменён",
    );
  }
  return toolCalls[0] as FunctionToolCall;
}

/**
 * Collects every function call of one model answer.
 *
 * A composite command ("1 роза, 3 алтая") makes the model answer with one call
 * per position, so the caller has to accept a set rather than a single call.
 */
export function getFunctionToolCalls(
  toolCalls: Array<FunctionToolCall | { type: string }> | undefined,
): FunctionToolCall[] {
  return (toolCalls ?? []).filter(
    (call): call is FunctionToolCall => call.type === "function",
  );
}