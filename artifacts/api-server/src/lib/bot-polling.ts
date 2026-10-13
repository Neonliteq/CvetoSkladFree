/**
 * Long-polling loop shared by both messengers.
 *
 * Long polling rather than webhooks: the shop runs a single instance behind a
 * reverse proxy, and polling needs no public callback URL, no certificate and no
 * subscription to keep in sync. It is also the only option that works from a
 * development machine.
 */
import { logger } from "./logger";

export type PollLoopOptions<TUpdate> = {
  name: string;
  /** Returns updates newer than `offset`, waiting up to the provider's timeout. */
  fetchUpdates: (offset: number) => Promise<{ updates: TUpdate[]; nextOffset: number }>;
  onUpdate: (update: TUpdate) => Promise<void>;
  /** Delay after a failure, in milliseconds. */
  retryDelayMs?: number;
};

export function startPollingLoop<TUpdate>(options: PollLoopOptions<TUpdate>) {
  let stopped = false;
  let offset = 0;

  const run = async () => {
    while (!stopped) {
      try {
        const { updates, nextOffset } = await options.fetchUpdates(offset);
        if (!stopped && nextOffset !== offset) offset = nextOffset;
        for (const update of updates) {
          if (stopped) break;
          try {
            await options.onUpdate(update);
          } catch (error) {
            // One bad message must not stop the bot for everybody else.
            logger.error({ err: error, bot: options.name }, "Could not handle a bot update");
          }
        }
      } catch (error) {
        // A messenger can be unreachable (blocked network, restart, rate limit):
        // log it once per attempt and keep the process alive.
        logger.warn({ err: error, bot: options.name }, "Bot polling failed, retrying");
        await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 5000));
      }
    }
  };

  void run();

  return {
    stop() {
      stopped = true;
    },
  };
}
