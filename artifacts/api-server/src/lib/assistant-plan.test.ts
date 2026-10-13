import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planFromToolCalls,
  describeClarification,
  describeOperation,
} from "./assistant-plan.ts";
import type { CatalogProduct } from "./assistant-context.ts";

/**
 * Каталог из задачи: «роза красная» подходит нескольким товарам, а «алтай» и
 * «брют» — однозначны. На этом различии держится частичное применение набора.
 */
const catalog: CatalogProduct[] = [
  { id: 1, name: "Роза Эквадор красная", aliases: ["роза красная"], productType: "stock", unit: "стебель", currentStock: 100 },
  { id: 2, name: "Роза Кения красная", aliases: ["роза красная"], productType: "stock", unit: "стебель", currentStock: 80 },
  { id: 3, name: "Роза Эквадор белая", aliases: ["роза белая"], productType: "stock", unit: "стебель", currentStock: 60 },
  { id: 4, name: "Хризантема Алтай", aliases: ["алтай"], productType: "stock", unit: "шт", currentStock: 40 },
  { id: 5, name: "Гвоздика Брют", aliases: ["брют"], productType: "stock", unit: "шт", currentStock: 30 },
  { id: 6, name: "Букет весенний", aliases: [], productType: "bouquet", currentStock: 5 },
];

const outflow = (productId: number, productName: string, quantity: number) => ({
  name: "create_outflow",
  arguments: JSON.stringify({ productId, productName, quantity, operationType: "expense" }),
});

test("составная команда: однозначные позиции становятся операциями, спорная — уточнением", () => {
  const plan = planFromToolCalls(
    [
      outflow(1, "роза красная", 1),
      outflow(4, "алтай", 3),
      outflow(5, "брют", 2),
    ],
    catalog,
  );

  assert.equal(plan.operations.length, 2, "однозначных позиций должно быть две");
  assert.deepEqual(
    plan.operations.map((operation) => operation.productId).sort(),
    [4, 5],
    "в операции должны попасть «алтай» и «брют»",
  );
  assert.equal(plan.clarifications.length, 1, "спорная позиция одна");
  assert.equal(plan.clarifications[0]?.asked, "роза красная");
  assert.equal(plan.clarifications[0]?.quantity, 1, "количество из команды сохраняется");
  assert.ok(
    plan.clarifications[0].options.length >= 2,
    "у уточнения должно быть несколько вариантов",
  );
});

test("спорная позиция не мешает остальным: набор не пустой", () => {
  const plan = planFromToolCalls(
    [outflow(1, "роза красная", 1), outflow(4, "алтай", 3)],
    catalog,
  );
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.clarifications.length, 1);
});

test("однозначная команда не создаёт уточнений", () => {
  const plan = planFromToolCalls([outflow(4, "алтай", 3)], catalog);
  assert.equal(plan.operations.length, 1);
  assert.equal(plan.clarifications.length, 0);
  assert.equal(plan.operations[0].quantity, 3);
  assert.equal(plan.operations[0].type, "expense");
});

test("товар-букет не участвует в складских операциях", () => {
  const plan = planFromToolCalls([outflow(6, "весенний", 1)], catalog);
  assert.equal(plan.operations.length, 0);
});

test("вызов с нечисловым количеством отбрасывается", () => {
  const broken = {
    name: "create_outflow",
    arguments: JSON.stringify({ productId: 4, productName: "алтай", quantity: "три" }),
  };
  const plan = planFromToolCalls([broken], catalog);
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.clarifications.length, 0);
});

test("испорченный JSON не роняет разбор набора", () => {
  const plan = planFromToolCalls(
    [
      { name: "create_outflow", arguments: "{не json" },
      outflow(4, "алтай", 3),
    ],
    catalog,
  );
  assert.equal(plan.operations.length, 1, "уцелевшая позиция остаётся");
});

test("приход распознаётся с закупочной ценой", () => {
  const plan = planFromToolCalls(
    [
      {
        name: "create_receipt",
        arguments: JSON.stringify({
          productId: 4,
          productName: "алтай",
          quantity: 10,
          unitPrice: 120,
        }),
      },
    ],
    catalog,
  );
  assert.equal(plan.operations[0].type, "receipt");
  assert.equal(plan.operations[0].unitPrice, 120);
});

test("списание и сборка сохраняют свой тип", () => {
  const plan = planFromToolCalls(
    [
      {
        name: "create_outflow",
        arguments: JSON.stringify({
          productId: 4,
          productName: "алтай",
          quantity: 1,
          operationType: "writeoff",
        }),
      },
      {
        name: "create_outflow",
        arguments: JSON.stringify({
          productId: 5,
          productName: "брют",
          quantity: 2,
          operationType: "production_input",
        }),
      },
    ],
    catalog,
  );
  assert.deepEqual(
    plan.operations.map((operation) => operation.type),
    ["writeoff", "production_input"],
  );
});

test("описания понятны пользователю", () => {
  const plan = planFromToolCalls(
    [outflow(4, "алтай", 3), outflow(1, "роза красная", 1)],
    catalog,
  );
  assert.match(describeOperation(plan.operations[0]), /Продажа: 3 шт «Хризантема Алтай»/);
  const text = describeClarification(plan.clarifications[0]);
  assert.match(text, /роза красная/);
  assert.match(text, /подходит несколько товаров/);
});
