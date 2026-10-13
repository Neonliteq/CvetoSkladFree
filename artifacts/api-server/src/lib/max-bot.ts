/**
 * MAX (max.ru) transport.
 *
 * The Bot API is a plain HTTP API at `botapi.max.ru`, authenticated with a bot
 * token. Two details learned from the live API shape this module:
 *
 *  - messages are addressed with a `user_id` query parameter, and sending needs
 *    a POST with an empty body rather than a JSON payload;
 *  - `/updates` is marker based, and long polling does not deliver anything while
 *    a webhook subscription exists for the bot.
 */
import { answerIncomingMessage } from "./bot-handler.ts";
import { botDependencies } from "./bot-dependencies.ts";
import { startPollingLoop } from "./bot-polling.ts";
import { botsEnabled } from "./bot-switch.ts";
import { logger } from "./logger.ts";

const apiBase = () => process.env["MAX_API_BASE"] ?? "https://botapi.max.ru";

type MaxUpdate = {
  update_type?: string;
  timestamp?: number;
  message?: {
    body?: { text?: string; mid?: string };
    sender?: { user_id?: number; first_name?: string; username?: string; name?: string };
    recipient?: { user_id?: number; chat_id?: number };
  };
};

async function max<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: { Authorization: token, ...(init?.headers ?? {}) },
    signal: AbortSignal.timeout(40_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MAX error ${response.status}: ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

let loop: { stop: () => void } | null = null;

/** Starts the MAX bot when bots are enabled and a token is configured. */
export async function startMaxBot(): Promise<void> {
  if (!botsEnabled()) {
    logger.info("BOTS_ENABLED is not set, the MAX bot stays off");
    return;
  }
  const token = process.env["MAX_BOT_TOKEN"];
  if (!token) {
    logger.info("MAX_BOT_TOKEN is not set, the MAX bot stays off");
    return;
  }

  try {
    const bot = await max<{ user_id: number; username?: string; name?: string }>(token, "/me");
    logger.info({ username: bot.username, name: bot.name }, "MAX bot connected");
  } catch (error) {
    logger.warn({ err: error }, "MAX bot is unavailable");
    return;
  }

  try {
    const subscriptions = await max<{ subscriptions?: Array<{ url: string }> }>(
      token,
      "/subscriptions",
    );
    if (subscriptions.subscriptions?.length) {
      // Long polling receives nothing while a webhook is subscribed.
      logger.warn(
        { count: subscriptions.subscriptions.length },
        "MAX bot has webhook subscriptions: long polling will not receive messages",
      );
    }
  } catch (error) {
    logger.warn({ err: error }, "Could not read MAX subscriptions");
  }

  loop = startPollingLoop<MaxUpdate>({
    name: "max",
    fetchUpdates: async (offset) => {
      const result = await max<{ updates?: MaxUpdate[]; marker?: number }>(
        token,
        `/updates?timeout=25&limit=100&marker=${offset}`,
      );
      const updates = result.updates ?? [];
      return { updates, nextOffset: result.marker ?? offset };
    },
    onUpdate: async (update) => {
      const message = update.message;
      const senderId = message?.sender?.user_id;
      const text = message?.body?.text;
      if (!senderId || !text) return;

      await answerIncomingMessage(
        {
          channel: "max",
          externalId: String(senderId),
          text,
          displayName: message?.sender?.name ?? message?.sender?.first_name ?? null,
          username: message?.sender?.username ?? null,
        },
        botDependencies(),
        async (reply) => {
          // The recipient goes in the query string and the text in the body.
          // Verified against the live API: an empty body answers
          // `400 proto.payload "Empty request body"`.
          await max(token, `/messages?user_id=${senderId}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: reply }),
          });
        },
      );
    },
  });
}

export function stopMaxBot(): void {
  loop?.stop();
  loop = null;
}
