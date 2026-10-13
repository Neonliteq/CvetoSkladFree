/**
 * Tool definitions and prompt for the stock assistant.
 *
 * Kept separate from the service so the web route, the bots and the tests share
 * exactly one description of what the assistant may do.
 */
import type { CatalogProduct } from "./assistant-context";

export const assistantTools = [
  {
    type: "function" as const,
    function: {
      name: "update_product",
      description: "Изменить поля существующего складского товара",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "productName", "changes"],
        properties: {
          productId: { type: "number" },
          productName: { type: "string" },
          changes: {
            type: "object",
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              category: { type: "string", enum: ["Цветы", "Упаковка", "Расходники", "Коробки", "Зелень"] },
              variety: { type: "string" },
              color: { type: "string" },
              unit: { type: "string", enum: ["шт", "стебель", "м", "см", "упак.", "пачка", "рулон", "кг", "г", "л"] },
              minimumStock: { type: "number" },
              shelfLifeDays: { type: "number" },
            },
          },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_receipt",
      description:
        "Только поступление или закупка: увеличить остаток существующего товара. Никогда не использовать для продажи, расхода или списания",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "productName", "quantity", "unitPrice"],
        properties: {
          productId: { type: "number" },
          productName: { type: "string" },
          quantity: { type: "number" },
          unitPrice: { type: "number" },
          markupPercent: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "create_outflow",
      description:
        "Уменьшить остаток товара: expense для продажи, выдачи или расхода; writeoff для порчи, брака или увядших цветов",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "productName", "quantity", "operationType"],
        properties: {
          productId: { type: "number" },
          productName: { type: "string" },
          quantity: { type: "number" },
          operationType: { type: "string", enum: ["expense", "production_input", "writeoff"] },
          saleUnitPrice: { type: "number" },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "set_stock_level",
      description:
        "Установить фактический остаток товара после пересчёта или инвентаризации. Использовать только когда пользователь явно просит установить, исправить или скорректировать остаток до конкретного значения",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["productId", "productName", "newStock"],
        properties: {
          productId: { type: "number" },
          productName: { type: "string" },
          newStock: { type: "number", minimum: 0 },
          reason: { type: "string" },
        },
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "update_receipt",
      description: "Исправить последний или указанный существующий приход",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["movementId", "changes"],
        properties: {
          movementId: { type: "number" },
          productName: { type: "string" },
          changes: {
            type: "object",
            additionalProperties: false,
            properties: {
              quantity: { type: "number" },
              unitPrice: { type: "number" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
  },
];

export type AssistantProductSummary = CatalogProduct & {
  category: string;
  unit: string;
  currentStock: number;
  minimumStock: number;
  purchasePrice: number;
  markupPercent: number;
  salePrice: number;
};

export type AssistantReceiptSummary = {
  id: number;
  productId: number;
  productName: string;
  quantity: number;
  unitPrice: number;
  reason: string;
  createdAt: Date;
};

/** System prompt: the assistant may only choose tools, never invent values. */
export function buildAssistantSystemPrompt(
  products: AssistantProductSummary[],
  receipts: AssistantReceiptSummary[],
) {
  return `Ты внимательный складской ассистент одного цветочного магазина. Отвечай по-русски кратко и естественно.

ГЛАВНОЕ ПРАВИЛО О ВОПРОСАХ. Если пользователь спрашивает о складе, а не просит что-то изменить — «покажи остатки», «сколько роз осталось», «что заканчивается», «что скоро испортится», «сколько стоит», «какие были операции» — вызывай инструмент ЧТЕНИЯ (list_stock, get_product, list_expiring, list_recent_operations). Никогда не отвечай на такие вопросы заглушкой «уточните, что нужно изменить»: данные придут от инструмента, и по ним нужно дать конкретный ответ.

КАКОЙ ИНСТРУМЕНТ ВЫБРАТЬ:
— «сколько роз осталось», «сколько чего на складе», «покажи остатки» → list_stock. Если спрашивают про конкретный товар, передай его в query («роз», «хризантем»), иначе список придёт целиком.
— «что заканчивается», «чего мало», «что пора заказывать» → list_stock с onlyLow: true. Не вызывай list_expiring для этого вопроса: он про срок годности, а не про остаток.
— «что скоро испортится», «какие поставки портятся», «у чего срок кончается» → list_expiring.
— «сколько стоит», «какая наценка», «когда привозили» → get_product с названием товара.
— «что делали», «последние операции» → list_recent_operations.
Если инструмент вернул «нет подходящих товаров», ответь по-русски обычными словами, что именно не нашлось, — не пересказывай технический текст.
Изменяющие инструменты (create_receipt, create_outflow, set_stock_level, update_receipt, update_product) вызывай только когда пользователь прямо просит изменить, принять, продать или списать.

Учитывай историю диалога. Слова «этот», «ещё», «столько же», «по той же цене» относятся к последнему однозначно обсуждавшемуся товару или действию.
Исправляй очевидные опечатки и сопоставляй разговорные названия с каталогом, включая явно указанные aliases. Не угадывай, если подходят несколько товаров.

ПОЛЕ productName. Передавай ровно то название, которое пользователь написал в команде: без количества, без цены, без слов «по», «за», «рублей» и без действия. «Приход 20 роз по 100» → productName «роз». «Продали 5 хризантем» → productName «хризантем». Если включить в название количество или цену, товар не найдётся в каталоге.
Название может стоять в любом падеже и числе («хризантем», «роз», «гвоздик») — каталог сопоставит его сам, менять падеж не нужно.
Никогда не подставляй в productName название другого товара из каталога.

Слова «продажа», «продали», «реализовали» означают продажу со склада. Слова «сборка», «собрали», «использовали для букета» означают передачу в производство. Слова «списать», «испорчено», «увяло», «брак» означают списание.
Для изменения данных обязательно вызывай ровно один инструмент. Не выдумывай id, количество, цену или дату. Если обязательных данных недостаточно, задай один конкретный уточняющий вопрос без инструмента.
После ответа на уточняющий вопрос восстанови параметры исходной просьбы из истории и выполни её.
Товары: ${JSON.stringify(
    products.map((product) => ({
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
    })),
  )}
Последние приходы: ${JSON.stringify(
    receipts.map((movement) => ({
      id: movement.id,
      productId: movement.productId,
      productName: movement.productName,
      quantity: movement.quantity,
      unitPrice: movement.unitPrice,
      reason: movement.reason,
      createdAt: movement.createdAt,
    })),
  )}`;
}
