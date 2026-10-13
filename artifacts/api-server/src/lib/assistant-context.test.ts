import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAssistantProductSelection,
  assertAssistantReceiptSelection,
  AssistantProductSelectionError,
  buildConversationMessages,
  getSingleFunctionToolCall,
} from "./assistant-context.ts";

const products = [
  { id: 1, name: "Пион", productType: "stock" },
  { id: 2, name: "кирпич", productType: "stock" },
];

test("keeps the original request before the next-message clarification", () => {
  const history = buildConversationMessages([
    { role: "user", content: "Freedom" },
    { role: "assistant", content: "Какой сорт розы выбрать?" },
    { role: "user", content: "Добавь приход 10 роз по 80 ₽" },
  ]);

  assert.deepEqual(history, [
    { role: "user", content: "Добавь приход 10 роз по 80 ₽" },
    { role: "assistant", content: "Какой сорт розы выбрать?" },
    { role: "user", content: "Freedom" },
  ]);
});

test("allows one command to create at most one operation", () => {
  const call = getSingleFunctionToolCall([
    {
      type: "function",
      function: { name: "create_receipt", arguments: '{"productId":1}' },
    },
  ]);

  assert.equal(call?.function.name, "create_receipt");
});

test("rejects an ambiguous multi-operation answer before changing inventory", () => {
  assert.throws(
    () =>
      getSingleFunctionToolCall([
        {
          type: "function",
          function: { name: "create_receipt", arguments: '{"productId":1}' },
        },
        {
          type: "function",
          function: { name: "create_receipt", arguments: '{"productId":2}' },
        },
      ]),
    /склад не изменён/,
  );
});

test("does not create an operation when clarification is required", () => {
  assert.equal(getSingleFunctionToolCall(undefined), undefined);
});

test("blocks brick when the user asked to write off peonies", () => {
  assert.throws(
    () => assertAssistantProductSelection({
      selectedProductId: 2,
      requestedProductName: "пионы",
      currentMessage: "Спиши 5 увядших пионов",
      products,
    }),
    AssistantProductSelectionError,
  );
});

test("accepts the unique product matching a Russian inflected name", () => {
  const selected = assertAssistantProductSelection({
    selectedProductId: 1,
    requestedProductName: "пионы",
    currentMessage: "Спиши 5 увядших пионов",
    products,
  });
  assert.equal(selected.id, 1);
});

test("accepts one obvious typo when it still identifies one product", () => {
  const selected = assertAssistantProductSelection({
    selectedProductId: 1,
    requestedProductName: "пиоон",
    currentMessage: "Спиши 5 увядших пиоонов",
    products,
  });
  assert.equal(selected.id, 1);
});

test("accepts a unique configured product alias", () => {
  const selected = assertAssistantProductSelection({
    selectedProductId: 1,
    requestedProductName: "пиончики",
    currentMessage: "Спиши 5 пиончиков",
    products: [
      { id: 1, name: "Пион Coral Charm", aliases: ["пиончики"], productType: "stock" },
      { id: 2, name: "Роза Freedom", aliases: [], productType: "stock" },
    ],
  });
  assert.equal(selected.id, 1);
});

test("asks for clarification if legacy data contains the same alias twice", () => {
  assert.throws(
    () => assertAssistantProductSelection({
      selectedProductId: 1,
      requestedProductName: "красная",
      currentMessage: "Спиши красную",
      products: [
        { id: 1, name: "Роза Freedom", aliases: ["красная"], productType: "stock" },
        { id: 2, name: "Роза Explorer", aliases: ["Красная"], productType: "stock" },
      ],
    }),
    /несколько товаров/,
  );
});

test("asks for clarification when a product reference is ambiguous", () => {
  assert.throws(
    () => assertAssistantProductSelection({
      selectedProductId: 1,
      requestedProductName: "роза",
      currentMessage: "Спиши одну розу",
      products: [
        { id: 1, name: "Роза красная", productType: "stock" },
        { id: 2, name: "Роза белая", productType: "stock" },
      ],
    }),
    /несколько товаров/,
  );
});

test("rejects a white rose selection when the command identifies the red rose", () => {
  assert.throws(
    () => assertAssistantProductSelection({
      selectedProductId: 2,
      requestedProductName: "роза белая",
      currentMessage: "Спиши розу красную",
      products: [
        { id: 1, name: "Роза красная", productType: "stock" },
        { id: 2, name: "Роза белая", productType: "stock" },
      ],
    }),
    /Команда относится к товару «Роза красная»/,
  );
});

test("allows a clear historical reference only with an anaphoric command", () => {
  const selected = assertAssistantProductSelection({
    selectedProductId: 1,
    requestedProductName: "пион",
    currentMessage: "Спиши ещё 2",
    recentUserMessages: ["Посчитай остаток пионов"],
    products,
  });
  assert.equal(selected.id, 1);
});

test("an anaphoric command uses the latest unambiguous product, not an older one", () => {
  assert.throws(
    () => assertAssistantProductSelection({
      selectedProductId: 2,
      requestedProductName: "кирпич",
      currentMessage: "Спиши ещё 2",
      recentUserMessages: [
        "Покажи остаток пионов",
        "Покажи остаток кирпича",
      ],
      products,
    }),
    /Команда относится к товару «Пион»/,
  );
});

test("a quantity and price clarification uses the product from the latest question", () => {
  const selected = assertAssistantProductSelection({
    selectedProductId: 1,
    requestedProductName: "пион",
    currentMessage: "10 по 100",
    recentConversationMessages: [
      { role: "assistant", content: "Сколько пионов добавить и по какой цене?" },
      { role: "user", content: "Добавь приход пионов" },
      { role: "user", content: "Покажи остаток кирпича" },
    ],
    products,
  });
  assert.equal(selected.id, 1);
});

test("an unknown named product never falls back to an older catalog product", () => {
  assert.throws(
    () => assertAssistantProductSelection({
      selectedProductId: 1,
      requestedProductName: "пион",
      currentMessage: "Спиши 5 гвоздик",
      recentConversationMessages: [
        { role: "user", content: "Покажи остаток пионов" },
      ],
      products,
    }),
    /текущей команды/,
  );
});

test("a receipt explicitly identified by number is accepted for its actual product", () => {
  assert.doesNotThrow(() => assertAssistantReceiptSelection({
    selectedMovementId: 42,
    movementProductId: 1,
    movementProductName: "Пион",
    requestedProductName: undefined,
    currentMessage: "Исправь приход №42: цена 120",
    latestReceiptId: 43,
    products,
  }));
});

test("only the actual latest receipt can satisfy a latest-receipt command", () => {
  assert.throws(
    () => assertAssistantReceiptSelection({
      selectedMovementId: 42,
      movementProductId: 1,
      movementProductName: "Пион",
      requestedProductName: undefined,
      currentMessage: "Исправь последний приход: цена 120",
      latestReceiptId: 43,
      products,
    }),
    /не последний приход/,
  );
});

test("a conflicting explicit receipt number is always rejected", () => {
  assert.throws(
    () => assertAssistantReceiptSelection({
      selectedMovementId: 42,
      movementProductId: 1,
      movementProductName: "Пион",
      requestedProductName: "пион",
      currentMessage: "Исправь приход №43 для пионов",
      latestReceiptId: 43,
      products,
    }),
    /другой номер прихода/,
  );
});