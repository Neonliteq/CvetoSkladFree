/**
 * Конфигурация AI-провайдера: из базы, с откатом на окружение.
 *
 * Администратор задаёт адрес API, ключ и модель в настройках. Пока в базе пусто,
 * работают значения из окружения — поэтому система поднимается и без настроек, а
 * смена ключа не требует правки файлов на сервере.
 *
 * Значения кешируются на несколько секунд: ассистент обращается к ним на каждый
 * запрос, а ходить в базу за тремя полями незачем. Сброс кеша происходит при
 * сохранении настроек, поэтому новый ключ действует сразу.
 */
import { eq } from "drizzle-orm";
import OpenAI from "@workspace/integrations-openai-ai-server/openai";
import { aiSettingsTable, db } from "@workspace/db";

export type ResolvedAiProvider = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /**
   * Чей ключ действует: свой ключ магазина или ключ платформы из окружения.
   * Магазину показывается только это слово — сам ключ платформы не отдаётся.
   */
  source: "shop" | "platform";
  /** Ключ задан, но наружу не отдаётся: интерфейс показывает только факт. */
  keySuffix: string | null;
};

const CACHE_MS = 15_000;

let cache: { value: ResolvedAiProvider | null; at: number } | null = null;

/** Сбрасывает кеш: вызывается после сохранения настроек. */
export function invalidateAiProviderCache(): void {
  cache = null;
}

const envValue = (name: string) =>
  process.env[name]?.trim() || process.env[`AI_INTEGRATIONS_${name}`]?.trim() || null;

const envApiKey = () =>
  process.env["OPENAI_API_KEY"]?.trim() ||
  process.env["AI_INTEGRATIONS_OPENAI_API_KEY"]?.trim() ||
  null;
const envBaseUrl = () =>
  process.env["OPENAI_BASE_URL"]?.trim() ||
  process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"]?.trim() ||
  null;

export function aiProviderFromEnvironment(): {
  apiKey: string | null;
  baseUrl: string | null;
  model: string;
} {
  return {
    apiKey: envApiKey(),
    baseUrl: envBaseUrl(),
    model: envValue("OPENAI_MODEL") ?? "deepseek-flash",
  };
}

/** Последние четыре символа ключа: по ним администратор узнаёт свой ключ. */
export function keySuffix(key: string | null | undefined): string | null {
  if (!key) return null;
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "••••";
  return `••••${trimmed.slice(-4)}`;
}

/**
 * Действующая конфигурация или null, если ключ и адрес не заданы нигде.
 *
 * Порядок: **ключ магазина** (если владелец его ввёл) → **ключ платформы** из
 * окружения. Так на общем сервере магазины работают на ключе владельца сервиса,
 * а кто хочет — подключает свой провайдер и не тратит чужой.
 *
 * Не бросает исключение: вызывающий код сам решает, что делать без провайдера —
 * ассистент отвечает понятной ошибкой, а остальная система работает.
 */
export async function resolveAiProvider(): Promise<ResolvedAiProvider | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.value;

  let row: typeof aiSettingsTable.$inferSelect | undefined;
  try {
    [row] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.id, 1));
  } catch {
    // Таблицы ещё нет (первый запуск до `db push`) — работаем на окружении.
    row = undefined;
  }

  const shopKey = row?.apiKey?.trim() || null;
  const shopBaseUrl = row?.baseUrl?.trim() || null;
  const shopModel = row?.model?.trim() || null;

  // Свой ключ магазина действует только целиком: ключ без адреса бессмыслен, а
  // подставлять к чужому ключу адрес платформы — верный способ получить
  // непонятную ошибку «провайдер отклонил запрос».
  const useShop = Boolean(shopKey && (shopBaseUrl || envBaseUrl()));
  const apiKey = useShop ? shopKey : envApiKey();
  const baseUrl = useShop ? (shopBaseUrl ?? envBaseUrl()) : envBaseUrl();
  const model = (useShop ? shopModel : null) ?? envValue("OPENAI_MODEL") ?? "deepseek-flash";

  const value: ResolvedAiProvider | null =
    apiKey && baseUrl
      ? {
          apiKey,
          baseUrl,
          model,
          source: useShop ? "shop" : "platform",
          keySuffix: keySuffix(apiKey),
        }
      : null;

  cache = { value, at: now };
  return value;
}

/** Сообщение для пользователя, когда провайдер не настроен. */
export const AI_NOT_CONFIGURED =
  "AI-провайдер не настроен: укажите адрес API и ключ в разделе «Настройки».";

/** Клиент провайдера по действующим настройкам; null, если он не настроен. */
export async function aiClient() {
  const provider = await resolveAiProvider();
  if (!provider) return null;
  return new OpenAI({ apiKey: provider.apiKey, baseURL: provider.baseUrl });
}

export type ActiveAiProvider = {
  client: OpenAI;
  model: string;
  baseUrl: string;
  source: "shop" | "platform";
};

/**
 * Действующий провайдер или понятная ошибка.
 *
 * Клиент собирается под каждый запрос: настройки меняет администратор, и они
 * должны действовать сразу, без перезапуска службы. Если провайдер не задан ни в
 * базе, ни в окружении, бросается текст «AI-провайдер не настроен» — он попадает
 * пользователю как обычная ошибка операции, а не как исключение SDK.
 */
export async function requireAiProvider(): Promise<ActiveAiProvider> {
  const resolved = await resolveAiProvider();
  if (!resolved) throw new Error(AI_NOT_CONFIGURED);
  return {
    client: new OpenAI({ apiKey: resolved.apiKey, baseURL: resolved.baseUrl }),
    model: resolved.model,
    baseUrl: resolved.baseUrl,
    source: resolved.source,
  };
}

export type AiConnectionResult = {
  ok: boolean;
  /** Что ответил провайдер: модель, число токенов или текст ошибки. */
  answer: string;
  /** Значения, против которых шла проверка. */
  baseUrl: string | null;
  model: string | null;
};

/**
 * Проверка связи с провайдером.
 *
 * Делает настоящий запрос, а не пинг адреса: адрес может отвечать, а ключ или
 * модель быть неверными — тогда ассистент не работает, хотя «связь есть».
 * Проверяются именно те значения, которые сохранены (или заданы в окружении).
 */
export async function testAiConnection(): Promise<AiConnectionResult> {
  const provider = await resolveAiProvider();
  if (!provider) {
    return { ok: false, answer: AI_NOT_CONFIGURED, baseUrl: null, model: null };
  }
  const client = await aiClient();
  if (!client) {
    return { ok: false, answer: AI_NOT_CONFIGURED, baseUrl: provider.baseUrl, model: provider.model };
  }
  try {
    const completion = await client.chat.completions.create(
      {
        model: provider.model,
        max_tokens: 16,
        messages: [{ role: "user", content: "Ответь одним словом: связь есть?" }],
      },
      { timeout: 20_000, maxRetries: 0 },
    );
    const reply = completion.choices[0]?.message?.content?.trim() || "(пустой ответ)";
    return {
      ok: true,
      answer: `Провайдер ответил моделью «${completion.model ?? provider.model}»: ${reply}`,
      baseUrl: provider.baseUrl,
      model: provider.model,
    };
  } catch (error) {
    return {
      ok: false,
      answer: describeProviderError(error),
      baseUrl: provider.baseUrl,
      model: provider.model,
    };
  }
}

/** Ошибку провайдера показываем текстом: администратору нужен код и причина. */
function describeProviderError(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { status?: number; message?: string; error?: unknown };
    const detail =
      typeof candidate.error === "object" && candidate.error !== null
        ? JSON.stringify(candidate.error).slice(0, 300)
        : (candidate.message ?? "");
    const status = candidate.status ? ` (HTTP ${candidate.status})` : "";
    return `Провайдер отклонил запрос${status}: ${detail || "без описания"}`;
  }
  return `Не удалось связаться с провайдером: ${String(error).slice(0, 200)}`;
}
