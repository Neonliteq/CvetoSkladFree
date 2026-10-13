/**
 * The stock assistant.
 *
 * Extracted from the HTTP route so the web interface, Telegram and MAX all run
 * the same command layer: the same prompt, the same tools, the same guards
 * against acting on a misunderstood command. A channel only supplies the
 * conversation id, the text and the author.
 *
 * A command may carry several positions ("1 роза красная, 3 алтая, 2 брют"), so
 * an answer is planned before it is written: definite positions become
 * operations, ambiguous ones become questions with options, and the user
 * confirms the preview before anything reaches the ledger.
 */
import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import {
  assistantConversationsTable,
  assistantMessagesTable,
  db,
  movementsTable,
  productsTable,
} from "@workspace/db";
import { CreateMovementBody } from "@workspace/api-zod";
import { requireAiProvider } from "./ai-config.ts";
import {
  assertAssistantProductSelection,
  buildConversationMessages,
  getFunctionToolCalls,
} from "./assistant-context.ts";
import {
  describeClarification,
  describeOperation,
  planFromToolCalls,
  type Clarification,
  type PlannedOperation,
  type RawToolCall,
} from "./assistant-plan.ts";
import { assistantTools, buildAssistantSystemPrompt } from "./assistant-tools.ts"
import { isReadTool, readTools, runReadTool } from "./assistant-read-tools.ts"
import { logger } from "./logger.ts";

export type AssistantCommandResult = {
  answer: string;
  action: string;
  operationId: number | null;
  canUndo: boolean;
  suggestions: string[];
  /** Разбор команды и итог его проведения — нужен мессенджерам и вебу. */
  plan?: AssistantPlanPayload;
  batchId?: string | null;
  applied?: AssistantAppliedOperation[];
  appliedCount?: number;
  errors?: string[];
};

/** A plan that is shown to the user before anything is written. */
export type AssistantPlanPayload = {
  operations: PlannedOperation[];
  clarifications: Clarification[];
};

/**
 * Неподтверждённый разбор вместе с командой, из которой он вырос.
 *
 * Мессенджер не показывает карточку с кнопкой «Провести», поэтому разбор
 * сохраняется и ждёт следующего сообщения: «да» проводит его, а название
 * товара — закрывает спорную позицию.
 */
export type PendingPlan = {
  message: string;
  plan: AssistantPlanPayload;
};

/** One written position of a plan. */
export type AssistantAppliedOperation = {
  movementId: number;
  productId: number;
  productName: string;
  quantity: number;
  unit: string;
  type: PlannedOperation["type"];
  description: string;
};

export type AssistantPlanResult = {
  answer: string;
  action: string;
  operationId: number | null;
  canUndo: boolean;
  suggestions: string[];
  /** Разбор команды: однозначные операции и спорные позиции. */
  plan: AssistantPlanPayload;
  /** Идентификатор набора операций, если он уже проведён. */
  batchId: string | null;
  /** Проведённые операции; пусто, пока пользователь не подтвердил план. */
  applied: AssistantAppliedOperation[];
  appliedCount: number;
  /** Позиции, которые не удалось провести. */
  errors: string[];
};

export type AssistantApplyInput = {
  conversationId: string;
  plan: {
    operations?: PlannedOperation[];
    clarifications?: Clarification[];
  };
};

export type AssistantApplyResult = {
  answer: string;
  action: string;
  batchId: string;
  appliedCount: number;
  movements: AssistantAppliedOperation[];
  errors: string[];
  canUndo: boolean;
  suggestions: string[];
};

const DEFAULT_SUGGESTIONS = [
  "Добавь приход 20 роз по 150 ₽",
  "Измени минимальный остаток ленты на 10",
  "Покажи последние приходы",
];

const PREVIEW_SUGGESTIONS = ["Подтверди разбор команды", "Укажи варианты для спорных позиций"];

/** Collaborators the assistant needs from the inventory layer. */
export type AssistantDependencies = {
  addMovement: (
    input: typeof CreateMovementBody._type,
    assistantMessage?: {
      conversationId: string;
      build: (movement: typeof movementsTable.$inferSelect) => { content: string; action: string };
    },
    assistantBatchId?: string | null,
  ) => Promise<typeof movementsTable.$inferSelect>;
  editReceipt: (
    movementId: number,
    changes: {
      quantity?: number;
      unitPrice?: number;
      reason?: string;
      batchArrivalDate?: Date | string;
      expiresAt?: Date | string | null;
    },
  ) => Promise<typeof movementsTable.$inferSelect>;
  recalculateDependentBouquets: (tx: unknown, componentProductId: number) => Promise<void>;
};

type ConversationInput = {
  conversationId: string;
  message: string;
  authorId?: number | null;
};

/** Everything the model answer is turned into, before anything is written. */
async function buildPlan(conversation: ConversationInput) {
  const { conversationId, message } = conversation;
  // Архивные товары ассистенту не показываем: их убрали из работы, и команда
  // «продажа роза» не должна попадать в позицию, которой в магазине больше нет.
  // Остаток архивного товара нулевой, поэтому раньше такая команда либо давала
  // ложное уточнение, либо упиралась в «недостаточно товара».
  const products = (await db.select().from(productsTable)).filter(
    (product) => product.archivedAt === null,
  );
  const receipts = await db
    .select()
    .from(movementsTable)
    .where(eq(movementsTable.type, "receipt"))
    .orderBy(desc(movementsTable.createdAt))
    .limit(30);

  await db
    .insert(assistantConversationsTable)
    .values({ id: conversationId })
    .onConflictDoUpdate({
      target: assistantConversationsTable.id,
      set: { updatedAt: new Date() },
    });
  await db.insert(assistantMessagesTable).values({
    conversationId,
    role: "user",
    content: message,
  });

  const recentMessages = await db
    .select({
      role: assistantMessagesTable.role,
      content: assistantMessagesTable.content,
    })
    .from(assistantMessagesTable)
    .where(eq(assistantMessagesTable.conversationId, conversationId))
    .orderBy(desc(assistantMessagesTable.createdAt), desc(assistantMessagesTable.id))
    .limit(16);

  const systemPrompt = buildAssistantSystemPrompt(products, receipts);
  // Провайдер берётся из настроек администратора (с откатом на окружение) на
  // каждый запрос: смена ключа или модели должна действовать сразу, без
  // перезапуска службы.
  const provider = await requireAiProvider();
  const completion = await provider.client.chat.completions.create(
    {
      model: provider.model,
      max_tokens: 1200,
      // DeepSeek enables thinking mode by default, where `reasoning_content`
      // must be echoed back on every subsequent tool-calling turn. The store
      // assistant only needs deterministic tool selection, so it runs in
      // non-thinking mode. Other OpenAI-compatible providers ignore the field.
      ...({ extra_body: { thinking: { type: "disabled" } } } as object),
      messages: [
        { role: "system", content: systemPrompt },
        ...buildConversationMessages(recentMessages).map((entry) => ({
          role: entry.role as "user" | "assistant",
          content: entry.content,
        })),
      ],
      // Инструменты чтения стоят первыми: вопросы к складу встречаются чаще
      // изменений, и без них модель отвечала заглушкой.
      tools: [...readTools, ...assistantTools],
    },
    // Commands arrive from phones too; the provider can be slow under load, and a
    // dropped command is worse than a slightly longer wait.
    { timeout: 60_000, maxRetries: 1 },
  );

  const choice = completion.choices[0]?.message;
  // A composite command makes the model answer with one call per position, so
  // the whole set is collected instead of insisting on a single call.
  const calls: RawToolCall[] = getFunctionToolCalls(choice?.tool_calls).map((call) => ({
    name: call.function.name,
    arguments: call.function.arguments,
  }));

  // Questions about the stock are answered from data, not from the model's
  // memory: the read tools run first, their output goes back into the dialogue,
  // and only then does the model write the reply. Bounded to two rounds so a
  // model that keeps asking for data cannot loop forever.
  const readCalls = calls.filter((call) => isReadTool(call.name));
  if (readCalls.length) {
    const messages: Array<Record<string, unknown>> = [
      { role: "system", content: systemPrompt },
      ...buildConversationMessages(recentMessages).map((entry) => ({
        role: entry.role as "user" | "assistant",
        content: entry.content,
      })),
    ];
    let collected = "";
    let pending = readCalls;
    for (let round = 0; round < 2; round += 1) {
      const results = await Promise.all(
        pending.map(async (call, index) => {
          try {
            return { call, index, text: await runReadTool(call.name, call.arguments) };
          } catch (error) {
            return {
              call,
              index,
              text: `Не удалось получить данные: ${error instanceof Error ? error.message : "ошибка"}`,
            };
          }
        }),
      );
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: results.map((result) => ({
          id: `read_${round}_${result.index}`,
          type: "function",
          function: { name: result.call.name, arguments: result.call.arguments },
        })),
        // DeepSeek требует это поле у сообщения с вызовами инструментов, даже
        // когда размышления отключены: без него — 400 «reasoning_content in the
        // thinking mode must be passed back». Пустая строка проверку проходит, а
        // тратить токены на размышления здесь незачем: ответ строится по данным.
        reasoning_content: "",
      });
      for (const result of results) {
        messages.push({
          role: "tool",
          tool_call_id: `read_${round}_${result.index}`,
          content: result.text,
        });
      }
      let followUp;
      try {
        followUp = await provider.client.chat.completions.create(
          {
            model: provider.model,
            max_tokens: 1200,
            // The thinking mode must stay off here too: with it on, DeepSeek
            // demands `reasoning_content` back on every tool-calling turn, and
            // this follow-up carries tool results.
            ...({ extra_body: { thinking: { type: "disabled" } } } as object),
            messages: messages as never,
            tools: [...readTools, ...assistantTools],
          },
          { timeout: 60_000, maxRetries: 1 },
        );
      } catch (error) {
        // Провайдер может отказать на повторе с результатами инструментов.
        // Данные уже получены, поэтому показываем их как есть: ответ по факту
        // полезнее ошибки «не удалось».
        logger.warn(
          { err: error },
          "Не удалось пересказать данные ассистентом, отдаю данные напрямую",
        );
        const collected = results.map((result) => result.text).join("\n");
        return {
          plan: { operations: [], clarifications: [], answer: collected },
          products,
          answer: collected,
          recentMessages,
        };
      }
      const followChoice = followUp.choices[0]?.message;
      collected = (followChoice?.content ?? "").trim();
      const moreReads = getFunctionToolCalls(followChoice?.tool_calls)
        .map((call) => ({ name: call.function.name, arguments: call.function.arguments }))
        .filter((call) => isReadTool(call.name));
      if (!moreReads.length) break;
      pending = moreReads;
    }
    return {
      plan: { operations: [], clarifications: [], answer: collected },
      products,
      answer: collected,
      recentMessages,
    };
  }

  const plan = planFromToolCalls(calls, products, message);
  verifyPlanSelections(plan, message, recentMessages, products);

  return { plan, products, answer: (choice?.content ?? "").trim(), recentMessages };
}

/**
 * Checks that every planned position really answers the command.
 *
 * The selection guards exist so a model guess can never move the wrong product;
 * they are applied per position, because the whole-command variant rejects a
 * composite command outright. Ambiguous positions never reach this point: they
 * went to `clarifications` and are decided by the user.
 */
function verifyPlanSelections(
  plan: ReturnType<typeof planFromToolCalls>,
  message: string,
  recentMessages: Array<{ role: string; content: string }>,
  products: Array<typeof productsTable.$inferSelect>,
) {
  const context = {
    currentMessage: message,
    recentConversationMessages: recentMessages.slice(1),
    products,
  };
  for (const operation of plan.operations) {
    if (plan.operations.length > 1) {
      if (operation.asked) {
        assertAssistantProductSelection({
          selectedProductId: operation.productId,
          requestedProductName: operation.asked,
          ...context,
          currentMessage: operation.asked,
        });
      }
      continue;
    }
    assertAssistantProductSelection({
      selectedProductId: operation.productId,
      requestedProductName: operation.asked || operation.productName,
      ...context,
    });
  }
}

/** Text of the preview: what will be written and what still needs a choice. */
function previewText(
  plan: ReturnType<typeof planFromToolCalls>,
  options?: { numberedChoices?: boolean },
): string {
  const lines: string[] = [];
  if (plan.operations.length) {
    lines.push(
      plan.operations.length === 1
        ? "Проверьте операцию:"
        : `Проверьте операции (${plan.operations.length}):`,
    );
    for (const operation of plan.operations) lines.push(`• ${describeOperation(operation)}`);
  }
  if (plan.clarifications.length) {
    lines.push("Нужно уточнить:");
    for (const clarification of plan.clarifications) {
      // В мессенджере нет кнопок, поэтому варианты нумеруются: на них можно
      // ответить цифрой.
      lines.push(
        options?.numberedChoices
          ? `• ${describeClarificationWithNumbers(clarification)}`
          : `• ${describeClarification(clarification)}`,
      );
    }
  }
  if (!lines.length) return "Не удалось разобрать команду. Назовите товар и количество.";
  lines.push("Подтвердите, чтобы провести операции.");
  return lines.join("\n");
}

/**
 * Plans a command without writing anything.
 *
 * Definite positions come back in `plan.operations`, ambiguous ones — with the
 * product options to choose from — in `plan.clarifications`. A single definite
 * position keeps the old behaviour: it is applied right away, so a simple
 * command still takes one round trip.
 */
export async function planAssistantCommand(
  input: ConversationInput,
  dependencies: AssistantDependencies,
): Promise<AssistantPlanResult> {
  const { plan, products } = await buildPlan(input);
  const multiPosition = plan.operations.length + plan.clarifications.length > 1;

  if (!plan.operations.length && !plan.clarifications.length) {
    const answer = plan.answer || "Уточните, что нужно изменить.";
    await saveAssistantMessage(input.conversationId, answer, "answered", null);
    return {
      answer,
      action: "answered",
      operationId: null,
      canUndo: false,
      suggestions: DEFAULT_SUGGESTIONS,
      plan: { operations: [], clarifications: [] },
      batchId: null,
      applied: [],
      appliedCount: 0,
      errors: [],
    };
  }

  // A composite command, or one with a doubtful position, is only shown: the
  // user confirms the breakdown before the ledger changes.
  if (multiPosition) {
    const answer = previewText(plan, { numberedChoices: true });
    await saveAssistantMessage(input.conversationId, answer, "plan_preview", null, {
      message: input.message,
      plan: { operations: plan.operations, clarifications: plan.clarifications },
    });
    return {
      answer,
      action: "plan_preview",
      operationId: null,
      canUndo: false,
      suggestions: PREVIEW_SUGGESTIONS,
      plan: { operations: plan.operations, clarifications: plan.clarifications },
      batchId: null,
      applied: [],
      appliedCount: 0,
      errors: [],
    };
  }

  const [operation] = plan.operations;
  if (!operation) {
    // Impossible in practice: a single clarification means `multiPosition`.
    const answer = previewText(plan);
    await saveAssistantMessage(input.conversationId, answer, "plan_preview", null, {
      message: input.message,
      plan: { operations: [], clarifications: plan.clarifications },
    });
    return {
      answer,
      action: "plan_preview",
      operationId: null,
      canUndo: false,
      suggestions: PREVIEW_SUGGESTIONS,
      plan: { operations: [], clarifications: plan.clarifications },
      batchId: null,
      applied: [],
      appliedCount: 0,
      errors: [],
    };
  }

  const batchId = randomUUID();
  const result = await applyResolvedPlan([operation], input.conversationId, dependencies, {
    batchId,
    products,
  });
  const [applied] = result.movements;
  const answer = applied
    ? describeApplied(applied, result.movements.length)
    : result.errors[0] ?? "Не удалось провести операцию — склад не изменён.";  await saveAssistantMessage(input.conversationId, answer, result.action, applied?.movementId ?? null);
  return {
    answer,
    action: result.action,
    operationId: applied?.movementId ?? null,
    canUndo: applied !== undefined,
    suggestions: DEFAULT_SUGGESTIONS,
    plan: { operations: plan.operations, clarifications: [] },
    batchId: result.movements.length > 1 ? batchId : null,
    applied: result.movements,
    appliedCount: result.movements.length,
    errors: result.errors,
  };
}

/**
 * Writes every position of a confirmed plan.
 *
 * All positions share one batch id, so the whole set can be reverted in one
 * go, and every position is reported individually: one failed line does not
 * hide the others.
 */
export async function applyAssistantPlan(
  input: AssistantApplyInput,
  dependencies: AssistantDependencies,
): Promise<AssistantApplyResult> {
  const { conversationId } = input;
  // Та же причина, что в `buildPlan`: план не должен проводиться по позиции,
  // которая лежит в архиве.
  const products = (await db.select().from(productsTable)).filter(
    (product) => product.archivedAt === null,
  );
  const operations = resolvePlanOperations(input.plan, products);
  if (!operations.length) {
    throw new Error("В плане нет операций для проведения");
  }
  const pending = (input.plan.clarifications ?? []).filter(
    (clarification) => !isClarificationResolved(clarification),
  );
  if (pending.length) {
    const list = pending.map((clarification) => `«${clarification.asked}»`).join(", ");
    const unknown = pending.filter((clarification) => !clarification.options.length);
    throw new Error(
      unknown.length
        ? `Позиции не распознаны: ${list}. Назовите товары точнее — склад не изменён`
        : `Выберите товар для спорных позиций: ${list}`,
    );
  }

  const batchId = randomUUID();
  const result = await applyResolvedPlan(operations, conversationId, dependencies, {
    batchId,
    products,
  });
  const answer = result.movements.length
    ? describeApplied(result.movements[0], result.movements.length)
    : result.errors[0] ?? "Не удалось провести операции — склад не изменён.";
  await saveAssistantMessage(conversationId, answer, result.action, null);
  return {
    answer,
    action: result.action,
    batchId,
    appliedCount: result.movements.length,
    movements: result.movements,
    errors: result.errors,
    canUndo: result.movements.length > 0,
    suggestions: DEFAULT_SUGGESTIONS,
  };
}

function isClarificationResolved(clarification: Clarification): boolean {
  return (
    typeof clarification.selectedProductId === "number" &&
    clarification.options.some((option) => option.id === clarification.selectedProductId)
  );
}

/** Уточнение с нумерацией вариантов: ответить можно цифрой. */
function describeClarificationWithNumbers(clarification: Clarification): string {
  if (!clarification.options.length) return describeClarification(clarification);
  const options = clarification.options
    .map((option, index) => `${index + 1}. ${option.name} (${option.stock} ${option.unit})`)
    .join(", ");
  return `«${clarification.asked}» — уточните, какой товар: ${options}. Ответьте номером или названием.`;
}

/**
 * Закрывает уточнения, в которых выбора нет.
 *
 * Если под название подошёл ровно один товар, спрашивать «какой выбрать» не о
 * чем: пользователь всё равно назовёт единственный вариант. Возвращает тот же
 * объект, если менять нечего, — вызывающий код сравнивает ссылки.
 */
function autoResolveSingleOptions(plan: AssistantPlanPayload): AssistantPlanPayload {
  let changed = false;
  const clarifications = plan.clarifications.map((clarification) => {
    if (isClarificationResolved(clarification)) return clarification;
    if (clarification.options.length !== 1) return clarification;
    changed = true;
    return { ...clarification, selectedProductId: clarification.options[0].id };
  });
  return changed ? { operations: plan.operations, clarifications } : plan;
}

/** Слова, которыми подтверждают разбор. */
const CONFIRM_WORDS = new Set([
  "да",
  "ага",
  "угу",
  "ок",
  "окей",
  "верно",
  "правильно",
  "точно",
  "подтверждаю",
  "подтвердить",
  "провести",
  "проводи",
  "применяй",
  "применить",
  "давай",
  "yes",
]);

/** Слова, которыми разбор отменяют. */
const CANCEL_WORDS = new Set([
  "нет",
  "отмена",
  "отмени",
  "отменить",
  "не надо",
  "не нужно",
  "стоп",
  "cancel",
]);

const normalizedReply = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase("ru")
    .replace(/[.!]+$/u, "")
    .replace(/\s+/gu, " ");

const isConfirmReply = (text: string) => CONFIRM_WORDS.has(normalizedReply(text));
const isCancelReply = (text: string) => CANCEL_WORDS.has(normalizedReply(text));

/** Команда с действием — это новая команда, а не ответ на разбор. */
const looksLikeNewCommand = (text: string) =>
  /\b(продал|продали|продать|списал|списали|списать|принял|приняли|принять|приход|закуп|собрал|собрали|собрать|пересчит|измени|поменя|поставь|сделай)\w*/iu.test(
    text,
  );

/**
 * Ищет вариант товара, который выбрал пользователь.
 *
 * Ответ «1» указывает на первый вариант, «роза кения» — на вариант по названию.
 * Слишком общий ответ («роза») не принимается: он подходит нескольким
 * вариантам, и выбирать должен человек, а не догадка.
 */
function matchClarificationOption(
  clarification: Clarification,
  reply: string,
): Clarification["options"][number] | undefined {
  const text = normalizedReply(reply).replace(/^(\d+)[.)]\s*/u, "$1 ");
  const numberMatch = /^(\d+)$/u.exec(text.trim());
  if (numberMatch) {
    return clarification.options[Number(numberMatch[1]) - 1];
  }
  const matches = clarification.options.filter((option) => {
    const name = option.name.toLocaleLowerCase("ru").replaceAll("ё", "е");
    return name.includes(text) || text.includes(name);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Читает сохранённый разбор: последний, который ещё не провели. */
async function loadPendingPlan(conversationId: string): Promise<PendingPlan | null> {
  const [row] = await db
    .select({ pendingPlan: assistantMessagesTable.pendingPlan })
    .from(assistantMessagesTable)
    .where(eq(assistantMessagesTable.conversationId, conversationId))
    .orderBy(desc(assistantMessagesTable.createdAt), desc(assistantMessagesTable.id))
    .limit(1);
  if (!row?.pendingPlan) return null;
  try {
    const parsed = JSON.parse(row.pendingPlan) as PendingPlan;
    if (!parsed?.plan) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Продолжает разговор, начатый разбором команды.
 *
 * Нужен мессенджерам: карточки с кнопкой «Провести» там нет, поэтому ответ
 * пользователя — «да» или название товара — применяется к сохранённому разбору.
 * Возвращает null, если сообщение не относится к предыдущему разбору: тогда
 * бот обрабатывает его как новую команду.
 */
export async function replyToPendingPlan(
  input: ConversationInput,
  dependencies: AssistantDependencies,
): Promise<AssistantCommandResult | null> {
  const text = input.message.trim();
  const hasPending = await loadPendingPlan(input.conversationId);
  if (!hasPending) return null;
  if (isCancelReply(text)) {
    await saveAssistantMessage(
      input.conversationId,
      "Отменил разбор, склад не изменён. Скажите, что сделать.",
      "answered",
      null,
    );
    return {
      answer: "Отменил разбор, склад не изменён. Скажите, что сделать.",
      action: "answered",
      operationId: null,
      canUndo: false,
      suggestions: DEFAULT_SUGGESTIONS,
      plan: { operations: [], clarifications: [] },
      batchId: null,
      applied: [],
      appliedCount: 0,
      errors: [],
    };
  }

  const initial = autoResolveSingleOptions(hasPending.plan);
  if (initial !== hasPending.plan) hasPending.plan = initial;
  const pendingClarifications = hasPending.plan.clarifications.filter(
    (clarification) => !isClarificationResolved(clarification),
  );

  if (pendingClarifications.length) {
    if (isConfirmReply(text)) {
      const asked = pendingClarifications
        .map((clarification) => `«${clarification.asked}»`)
        .join(", ");
      const answer = `Сначала выберите товар: ${asked}. Ответьте номером или названием — склад не изменён.`;
      await saveAssistantMessage(input.conversationId, answer, "plan_preview", null, hasPending);
      return { ...emptyResult(answer, "plan_preview"), suggestions: PREVIEW_SUGGESTIONS };
    }
    // Новую команду разбор не перебивает: она обрабатывается как обычно.
    if (looksLikeNewCommand(text)) return null;
    const picked = matchClarificationOption(pendingClarifications[0], text);
    if (!picked) {
      const answer = `Не понял, какой товар выбрать. ${describeClarificationWithNumbers(pendingClarifications[0])}`;
      await saveAssistantMessage(input.conversationId, answer, "plan_preview", null, hasPending);
      return { ...emptyResult(answer, "plan_preview"), suggestions: PREVIEW_SUGGESTIONS };
    }
    const resolved = autoResolveSingleOptions({
      operations: hasPending.plan.operations,
      clarifications: hasPending.plan.clarifications.map((clarification) =>
        clarification === pendingClarifications[0]
          ? { ...clarification, selectedProductId: picked.id }
          : clarification,
      ),
    });
    const remaining = resolved.clarifications.filter(
      (clarification) => !isClarificationResolved(clarification),
    );
    if (remaining.length) {
      const preview = previewText(
        { operations: resolved.operations, clarifications: remaining, answer: "" },
        { numberedChoices: true },
      );
      await saveAssistantMessage(input.conversationId, preview, "plan_preview", null, {
        message: hasPending.message,
        plan: resolved,
      });
      return { ...emptyResult(preview, "plan_preview"), suggestions: PREVIEW_SUGGESTIONS };
    }
    return applyPendingPlan(resolved, input, dependencies);
  }

  if (!isConfirmReply(text)) {
    // Не команда и не подтверждение: пусть разбор остаётся в силе, а сообщение
    // обрабатывается как новая команда.
    return null;
  }
  return applyPendingPlan(hasPending.plan, input, dependencies);
}

function emptyResult(answer: string, action: string): AssistantCommandResult {
  return {
    answer,
    action,
    operationId: null,
    canUndo: false,
    suggestions: DEFAULT_SUGGESTIONS,
    plan: { operations: [], clarifications: [] },
    batchId: null,
    applied: [],
    appliedCount: 0,
    errors: [],
  };
}

/** Проводит подтверждённый разбор и очищает ожидание. */
async function applyPendingPlan(
  plan: AssistantPlanPayload,
  input: ConversationInput,
  dependencies: AssistantDependencies,
): Promise<AssistantCommandResult> {
  const result = await applyAssistantPlan(
    { conversationId: input.conversationId, plan },
    dependencies,
  );
  return {
    answer: result.answer,
    action: result.action,
    operationId: result.movements[0]?.movementId ?? null,
    canUndo: result.canUndo,
    suggestions: DEFAULT_SUGGESTIONS,
    plan,
    batchId: result.batchId,
    applied: result.movements,
    appliedCount: result.appliedCount,
    errors: result.errors,
  };
}

/**
 * Turns the confirmed plan into concrete operations.
 *
 * A clarified position carries the product the user picked; a plain position is
 * already concrete. Every picked product must belong to the offered options, so
 * a tampered request cannot write an arbitrary product.
 */
function resolvePlanOperations(
  plan: AssistantApplyInput["plan"],
  products: Array<typeof productsTable.$inferSelect>,
): PlannedOperation[] {
  const operations: PlannedOperation[] = [...(plan.operations ?? [])];
  for (const clarification of plan.clarifications ?? []) {
    if (typeof clarification.selectedProductId !== "number") continue;
    const option = clarification.options.find(
      (candidate) => candidate.id === clarification.selectedProductId,
    );
    if (!option) {
      throw new Error(
        `Товар для позиции «${clarification.asked}» не входит в предложенные варианты`,
      );
    }
    const product = products.find((item) => item.id === option.id);
    if (!product) throw new Error(`Товар «${option.name}» больше не найден в каталоге`);
    operations.push({
      index: clarification.index,
      asked: clarification.asked,
      productId: product.id,
      productName: product.name,
      unit: product.unit ?? "шт",
      type: clarification.type,
      quantity: clarification.quantity,
    });
  }
  return operations;
}

/** Writes the operations one by one and reports what happened to each. */
async function applyResolvedPlan(
  operations: PlannedOperation[],
  conversationId: string,
  dependencies: AssistantDependencies,
  options: { batchId: string; products: Array<typeof productsTable.$inferSelect> },
): Promise<{
  movements: AssistantAppliedOperation[];
  errors: string[];
  action: string;
}> {
  const movements: AssistantAppliedOperation[] = [];
  const errors: string[] = [];
  let action = "answered";

  for (const operation of operations) {
    const unit = operation.unit ?? "шт";
    const input = movementInput(operation);
    const parsed = CreateMovementBody.safeParse(input);
    if (!parsed.success) {
      errors.push(`«${operation.asked}»: неверные данные операции`);
      continue;
    }
    try {
      const movement = await dependencies.addMovement(
        parsed.data,
        undefined,
        options.batchId,
      );
      const applied: AssistantAppliedOperation = {
        movementId: movement.id,
        productId: movement.productId,
        productName: movement.productName,
        quantity: movement.quantity,
        unit,
        type: movement.type as PlannedOperation["type"],
        description: describeOperation({ ...operation, unit }),
      };
      movements.push(applied);
      action = actionOf(operation.type);
    } catch (error) {
      const message = error instanceof Error ? error.message : "операция не проведена";
      errors.push(`«${operation.asked}»: ${message}`);
    }
  }

  return { movements, errors, action };
}

/** Movement body for one planned position; the same shapes the old flow used. */
function movementInput(operation: PlannedOperation) {
  if (operation.type === "receipt") {
    return {
      productId: operation.productId,
      type: "receipt" as const,
      quantity: operation.quantity,
      unitPrice: operation.unitPrice,
      markupPercent: operation.markupPercent,
      reason: operation.reason || "Приход через AI-ассистента",
    };
  }
  return {
    productId: operation.productId,
    type: operation.type,
    quantity: operation.quantity,
    saleUnitPrice: operation.saleUnitPrice,
    reason:
      operation.reason ||
      (operation.type === "writeoff"
        ? "Списание через AI-ассистента"
        : operation.type === "production_input"
          ? "Сборка через AI-ассистента"
          : "Расход через AI-ассистента"),
  };
}

function actionOf(type: PlannedOperation["type"]): string {
  if (type === "receipt") return "receipt_created";
  if (type === "writeoff") return "writeoff_created";
  if (type === "production_input") return "assembly_created";
  return "expense_created";
}

/** Answer for one or several written positions. */
function describeApplied(
  applied: AssistantAppliedOperation,
  total: number,
): string {
  const verb =
    applied.type === "receipt"
      ? "Приход добавлен"
      : applied.type === "writeoff"
        ? "Списано"
        : applied.type === "production_input"
          ? "Передано в сборку"
          : "Продажа проведена";
  const line = `${verb}: ${applied.productName}, ${applied.quantity} ${applied.unit}.`;
  return total > 1 ? `Проведено операций: ${total}. ${line}` : line;
}

async function saveAssistantMessage(
  conversationId: string,
  content: string,
  action: string,
  movementId: number | null,
  pendingPlan?: PendingPlan | null,
) {
  await db.insert(assistantMessagesTable).values({
    conversationId,
    role: "assistant",
    content,
    action,
    movementId,
    pendingPlan: pendingPlan ? JSON.stringify(pendingPlan) : null,
  });
}

/**
 * Runs one command and returns what should be shown to the user.
 *
 * Kept for the callers that answer a single messenger message: a definite
 * single position is applied immediately, everything else comes back as a
 * question or a preview.
 */
export async function runAssistantCommand(
  input: ConversationInput,
  dependencies: AssistantDependencies,
): Promise<AssistantCommandResult> {
  const result = await planAssistantCommand(input, dependencies);
  return {
    answer: result.answer,
    action: result.action,
    operationId: result.operationId,
    canUndo: result.canUndo,
    suggestions: result.suggestions,
  };
}

/**
 * Runs a command and turns "which product did you mean?" into a normal answer.
 *
 * Both the web route and the bots need that behaviour, so it lives next to the
 * service rather than in either caller.
 */
export async function runAssistantCommandSafely(
  input: ConversationInput,
  dependencies: AssistantDependencies,
): Promise<AssistantCommandResult> {
  try {
    return await runAssistantCommand(input, dependencies);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось выполнить команду";
    await db.insert(assistantMessagesTable).values({
      conversationId: input.conversationId,
      role: "assistant",
      content: message,
      action: "answered",
    });
    return {
      answer: message,
      action: "answered",
      operationId: null,
      canUndo: false,
      suggestions: DEFAULT_SUGGESTIONS,
    };
  }
}
