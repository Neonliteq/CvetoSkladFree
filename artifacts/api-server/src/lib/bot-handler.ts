/**
 * The bot behaviour, independent of the messenger that delivers the message.
 *
 * Both Telegram and MAX funnel into `answerIncomingMessage`, so access control,
 * the assistant and the audit trail exist once. A provider only moves bytes.
 */
import type { MessengerChannel } from "@workspace/db";
import { issueLinkCode, linkInstructions, resolveChannelAuthor } from "./channel-access.ts";
import {
  replyToPendingPlan,
  runAssistantCommandSafely,
  type AssistantDependencies,
} from "./assistant.ts";
import { logger } from "./logger.ts";

export type IncomingMessage = {
  channel: MessengerChannel;
  externalId: string;
  text: string;
  displayName?: string | null;
  username?: string | null;
};

/**
 * Decides what to answer and hands the text to `send`.
 *
 * Kept free of any messenger SDK: a provider supplies `send`, which makes the
 * whole behaviour testable without touching a real bot.
 */
export async function answerIncomingMessage(
  message: IncomingMessage,
  dependencies: AssistantDependencies,
  send: (reply: string) => Promise<void>,
): Promise<void> {
  const text = message.text.trim();
  if (!text) return;

  const author = await resolveChannelAuthor(message.channel, message.externalId);
  if (!author) {
    // Unknown account: no data, no operations — only a way to ask for access.
    const code = await issueLinkCode({
      channel: message.channel,
      externalId: message.externalId,
      displayName: message.displayName,
      username: message.username,
    });
    logger.info(
      { channel: message.channel, externalId: message.externalId },
      "Unlinked messenger account asked for access",
    );
    await send(linkInstructions(message.channel, code));
    return;
  }

  const conversation = {
    conversationId: author.conversationId,
    message: text,
    authorId: author.userId,
  };

  // Сначала проверяем, не отвечает ли пользователь на предыдущий разбор: в
  // мессенджере нет кнопки «Провести», и подтверждением служит следующее
  // сообщение.
  const followUp = await replyToPendingPlan(conversation, dependencies);
  if (followUp) {
    await send(followUp.answer);
    return;
  }

  const result = await runAssistantCommandSafely(conversation, dependencies);
  await send(result.answer);
}
