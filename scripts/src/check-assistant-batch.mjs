/**
 * Проверяет разбор составных команд ассистента.
 *
 * Сценарий из практики магазина: одна команда содержит несколько позиций. До
 * записи в учёт пользователь видит разбор, спорная позиция не блокирует
 * остальные, а весь набор отменяется одной операцией.
 *
 * Проверка намеренно разделяет два случая:
 *   1) команда из однозначных позиций — модель вызывает инструмент на каждую
 *      позицию, API показывает разбор и не пишет в учёт;
 *   2) команда со спорной позицией — по ней API отдаёт варианты выбора.
 * Так проверка не зависит от того, вернёт ли модель вызов инструмента вместе с
 * вопросом по спорной позиции.
 *
 * Usage: node scripts/src/check-assistant-batch.mjs
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
    parsed = text.slice(0, 200);
  }
  return { status: response.status, body: parsed };
};

const products = (await call("GET", "/api/products")).body ?? [];
const stockOf = async (id) =>
  ((await call("GET", "/api/products")).body ?? []).find((p) => p.id === id)
    ?.currentStock;

const words = "роза";
const ambiguousMatches = products
  .filter((item) => item.productType === "stock" && item.name.toLowerCase().includes(words))
  .map((item) => item.name);
if (ambiguousMatches.length < 2) {
  throw new Error(`В каталоге нет нескольких товаров со словом «${words}»`);
}
const clearItems = products
  .filter((item) => item.productType === "stock" && !item.name.toLowerCase().includes(words))
  .slice(0, 2);
const [clearOne, clearTwo] = clearItems;
record(
  "подготовлены товары для команды",
  Boolean(clearOne && clearTwo) && ambiguousMatches.length >= 2,
  `однозначные: ${clearOne?.name}, ${clearTwo?.name}; спорные: ${ambiguousMatches.join(", ")}`,
);

const stockBefore = Object.fromEntries(
  [clearOne, clearTwo].map((item) => [item.id, item.currentStock]),
);
const planOf = (body) => body?.plan ?? { operations: [], clarifications: [] };

// ---------------------------------------------------- 1. Однозначная составная команда
console.log("\n=== 1. Составная команда из однозначных позиций: разбор без записи ===");
const conversationId = `batch-check-${Date.now()}`;
const command = [`Продажа 3 ${clearOne.name}`, `2 ${clearTwo.name}`].join(", ");
const planned = await call("POST", "/api/assistant/command", {
  conversationId,
  message: command,
});
record("команда принята", planned.status === 200, `статус ${planned.status}`);
console.log("  разбор:", JSON.stringify(planOf(planned.body)).slice(0, 300));

const plan = planOf(planned.body);
record(
  "в разборе по позиции на каждый товар",
  plan.operations.length >= 2,
  `операций: ${plan.operations.length}`,
);
record(
  "в разборе нет уточнений",
  plan.clarifications.length === 0,
  JSON.stringify(plan.clarifications).slice(0, 150),
);
record(
  "у операции есть человекочитаемое описание",
  plan.operations.every((operation) => typeof operation.description === "string" || operation.productName),
  JSON.stringify(plan.operations[0]).slice(0, 150),
);
record(
  "в предпросмотре указано количество из команды",
  plan.operations[0]?.quantity === 3 && plan.operations[1]?.quantity === 2,
  JSON.stringify(plan.operations.map((operation) => operation.quantity)),
);
record(
  "до подтверждения операции не проведены",
  planned.body?.appliedCount === 0 && planned.body?.batchId === null,
  JSON.stringify({ appliedCount: planned.body?.appliedCount, batchId: planned.body?.batchId }),
);

console.log("\n=== 2. До подтверждения склад не изменён ===");
record(
  "остатки не изменились",
  (await stockOf(clearOne.id)) === stockBefore[clearOne.id] &&
    (await stockOf(clearTwo.id)) === stockBefore[clearTwo.id],
  JSON.stringify({
    before: stockBefore,
    now: [await stockOf(clearOne.id), await stockOf(clearTwo.id)],
  }),
);

console.log("\n=== 3. Подтверждение проводит все позиции набора ===");
const applied = await call("POST", "/api/assistant/command/apply", {
  conversationId,
  plan: { operations: plan.operations, clarifications: plan.clarifications },
});
record("применение прошло", applied.status === 200, `статус ${applied.status} ${JSON.stringify(applied.body).slice(0, 150)}`);
record(
  "проведены все позиции",
  (applied.body?.appliedCount ?? applied.body?.movements?.length ?? 0) >= 2,
  JSON.stringify(applied.body).slice(0, 150),
);
record(
  "остаток первого товара уменьшился на 3",
  (await stockOf(clearOne.id)) === stockBefore[clearOne.id] - 3,
  `${stockBefore[clearOne.id]} → ${await stockOf(clearOne.id)}`,
);
record(
  "остаток второго товара уменьшился на 2",
  (await stockOf(clearTwo.id)) === stockBefore[clearTwo.id] - 2,
  `${stockBefore[clearTwo.id]} → ${await stockOf(clearTwo.id)}`,
);

console.log("\n=== 4. Отмена всего набора ===");
const batchId = applied.body?.batchId ?? applied.body?.assistantBatchId;
record("набор имеет идентификатор", typeof batchId === "string" && batchId.length > 0, String(batchId));

if (batchId) {
  const undone = await call("POST", `/api/assistant/batches/${batchId}/undo`, {});
  record("отмена набора прошла", undone.status === 200, `статус ${undone.status} ${JSON.stringify(undone.body).slice(0, 120)}`);
  record(
    "остатки вернулись к исходным",
    (await stockOf(clearOne.id)) === stockBefore[clearOne.id] &&
      (await stockOf(clearTwo.id)) === stockBefore[clearTwo.id],
    JSON.stringify(
      [clearOne, clearTwo].map((item) => `${item.name}: ${stockBefore[item.id]}`),
    ),
  );
}

// ------------------------------------------------------------- 5. Спорная позиция
console.log("\n=== 5. Спорная позиция: варианты выбора без проведения ===");
const ambiguousConversation = `${conversationId}-ambiguous`;
const ambiguousPlanned = await call("POST", "/api/assistant/command", {
  conversationId: ambiguousConversation,
  message: `Продажа 1 ${words}`,
});
record("команда со спорной позицией принята", ambiguousPlanned.status === 200, `статус ${ambiguousPlanned.status}`);
const ambiguousPlan = planOf(ambiguousPlanned.body);
const clarification = ambiguousPlan.clarifications.find((item) =>
  item.asked.toLowerCase().includes(words),
);
record(
  "спорная позиция выделена в уточнение",
  Boolean(clarification),
  JSON.stringify(ambiguousPlan).slice(0, 200),
);
record(
  "у уточнения есть варианты выбора",
  (clarification?.options?.length ?? 0) >= 2,
  `вариантов: ${clarification?.options?.length ?? 0}`,
);
record(
  "в уточнении указано количество из команды",
  clarification?.quantity === 1,
  String(clarification?.quantity),
);
record(
  "спорная позиция не проведена",
  ambiguousPlan.operations.length === 0 && ambiguousPlanned.body?.appliedCount === 0,
  JSON.stringify({ operations: ambiguousPlan.operations.length, appliedCount: ambiguousPlanned.body?.appliedCount }),
);

if (clarification) {
  const chosen = clarification.options[0];
  const stockBeforeChoice = await stockOf(chosen.id);
  const resolved = await call("POST", "/api/assistant/command/apply", {
    conversationId: ambiguousConversation,
    plan: {
      operations: ambiguousPlan.operations,
      clarifications: ambiguousPlan.clarifications.map((item) => ({
        ...item,
        selectedProductId: item.index === clarification.index ? chosen.id : item.options?.[0]?.id,
      })),
    },
  });
  record("выбранный вариант проведён", resolved.status === 200 && resolved.body?.appliedCount === 1, `статус ${resolved.status} ${JSON.stringify(resolved.body).slice(0, 150)}`);
  record(
    "остаток выбранного товара уменьшился на 1",
    (await stockOf(chosen.id)) === stockBeforeChoice - 1,
    `${stockBeforeChoice} → ${await stockOf(chosen.id)}`,
  );
}

console.log("\n=== 6. Одиночная однозначная команда работает как раньше ===");
const single = await call("POST", "/api/assistant/command", {
  conversationId: `${conversationId}-single`,
  message: `Продажа 1 ${clearOne.name}`,
});
record("одиночная команда принята", single.status === 200, `статус ${single.status}`);
record(
  "одиночная команда проведена сразу, как раньше",
  Boolean(single.body?.operationId) && single.body?.action === "expense_created",
  JSON.stringify(single.body).slice(0, 150),
);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
