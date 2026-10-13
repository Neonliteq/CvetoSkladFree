/**
 * Telegram transport.
 *
 * Talks to the Bot API directly with a token from the environment. An earlier
 * hosted connector was removed: it only worked on the hosting platform, and the project now
 * runs on its own server.
 */
import { answerIncomingMessage } from "./bot-handler.ts";
import { botDependencies } from "./bot-dependencies.ts";
import { startPollingLoop } from "./bot-polling.ts";
import { botsEnabled } from "./bot-switch.ts";
import { logger } from "./logger.ts";

const apiBase = () => process.env["TELEGRAM_API_BASE"] ?? "https://api.telegram.org";

type TelegramUpdate = {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
    from?: { id: number; first_name?: string; username?: string };
  };
};

type TelegramEnvelope<T> = { ok: boolean; result?: T; description?: string };

async function telegram<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}/bot${token}${path}`, {
    ...init,
    signal: AbortSignal.timeout(40_000),
  });
  const body = (await response.json()) as TelegramEnvelope<T>;
  if (!response.ok || !body.ok) {
    throw new Error(body.description ?? `Telegram error ${response.status}`);
  }
  return body.result as T;
}

let loop: { stop: () => void } | null = null;

/** Starts the Telegram bot when bots are enabled and a token is configured. */
export async function startTelegramBot(): Promise<void> {
  if (!botsEnabled()) {
    logger.info("BOTS_ENABLED is not set, the Telegram bot stays off");
    return;
  }
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) {
    logger.info("TELEGRAM_BOT_TOKEN is not set, the Telegram bot stays off");
    return;
  }

  try {
    const bot = await telegram<{ username?: string }>(token, "/getMe");
    logger.info({ username: bot.username }, "Telegram bot connected");
  } catch (error) {
    // The network can block api.telegram.org entirely; the API server must still
    // start, so this is a warning and polling is not attempted.
    logger.warn({ err: error }, "Telegram bot is unavailable");
    return;
  }

  loop = startPollingLoop<TelegramUpdate>({
    name: "telegram",
    fetchUpdates: async (offset) => {
      const updates = await telegram<TelegramUpdate[]>(
        token,
        `/getUpdates?timeout=25&offset=${offset}`,
      );
      const last = updates.at(-1);
      return { updates, nextOffset: last ? last.update_id + 1 : offset };
    },
    onUpdate: async (update) => {
      const message = update.message;
      if (!message?.text || !message.from) return;
      await answerIncomingMessage(
        {
          channel: "telegram",
          externalId: String(message.from.id),
          text: message.text,
          displayName: message.from.first_name ?? null,
          username: message.from.username ?? null,
        },
        botDependencies(),
        async (reply) => {
          await telegram(token, "/sendMessage", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: message.chat.id, text: reply }),
          });
        },
      );
    },
  });
}

export function stopTelegramBot(): void {
  loop?.stop();
  loop = null;
}
