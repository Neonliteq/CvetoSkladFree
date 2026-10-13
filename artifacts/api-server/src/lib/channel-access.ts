/**
 * Access control for the messengers.
 *
 * A messenger message carries no password, so the only question that matters is
 * "is this account linked to a staff member?". Anything else — an unknown id, a
 * disabled account, a revoked link — gets the same answer: no access, plus a
 * one-time code the user can claim in the web interface.
 */
import { and, eq, isNull } from "drizzle-orm";
import {
  channelIdentitiesTable,
  channelLinkCodesTable,
  db,
  usersTable,
  type MessengerChannel,
} from "@workspace/db";
import { createToken, hashToken } from "./auth";
import { logger } from "./logger.ts";

/** A code lives long enough to be typed, and not much longer. */
const LINK_CODE_TTL_MS = 30 * 60 * 1000;

export type ChannelAuthor = {
  userId: number;
  displayName: string;
  role: "admin" | "staff";
  conversationId: string;
  identityId: number;
};

/** Stable conversation id so the assistant keeps the context of one chat. */
export const conversationIdFor = (channel: MessengerChannel, externalId: string) =>
  `${channel}:${externalId}`;

/** The staff member behind a messenger account, if the link is still valid. */
export async function resolveChannelAuthor(
  channel: MessengerChannel,
  externalId: string,
): Promise<ChannelAuthor | null> {
  const [row] = await db
    .select({
      identity: channelIdentitiesTable,
      user: usersTable,
    })
    .from(channelIdentitiesTable)
    .innerJoin(usersTable, eq(channelIdentitiesTable.userId, usersTable.id))
    .where(
      and(
        eq(channelIdentitiesTable.channel, channel),
        eq(channelIdentitiesTable.externalId, externalId),
      ),
    );

  if (!row || !row.identity.isActive || !row.user.isActive) return null;

  await db
    .update(channelIdentitiesTable)
    .set({ lastSeenAt: new Date() })
    .where(eq(channelIdentitiesTable.id, row.identity.id));

  return {
    userId: row.user.id,
    displayName: row.user.displayName,
    role: row.user.role,
    conversationId: conversationIdFor(channel, externalId),
    identityId: row.identity.id,
  };
}

/**
 * Issues a one-time linking code for an unlinked messenger account.
 *
 * Repeated requests reuse nothing: each code is new, and only the newest one is
 * meant to be typed. Storing the hash keeps the audit trail useless to a thief.
 */
export async function issueLinkCode(input: {
  channel: MessengerChannel;
  externalId: string;
  displayName?: string | null;
  username?: string | null;
}): Promise<string> {
  const code = createToken(9).replace(/[-_]/gu, "").slice(0, 8).toLocaleUpperCase("en");
  await db.insert(channelLinkCodesTable).values({
    codeHash: hashToken(code),
    channel: input.channel,
    externalId: input.externalId,
    displayName: input.displayName ?? null,
    username: input.username ?? null,
    expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
  });
  return code;
}

export type ClaimResult =
  | { ok: true; userDisplayName: string; channel: MessengerChannel }
  | { ok: false; reason: string };

/**
 * Claims a code on behalf of the signed-in staff member.
 *
 * Claiming twice is impossible: the code is marked as used inside the same
 * statement that finds it unclaimed.
 */
export async function claimLinkCode(code: string, userId: number): Promise<ClaimResult> {
  const normalized = code.trim().replace(/\s+/gu, "").toLocaleUpperCase("en");
  const [pending] = await db
    .select()
    .from(channelLinkCodesTable)
    .where(
      and(
        eq(channelLinkCodesTable.codeHash, hashToken(normalized)),
        isNull(channelLinkCodesTable.claimedAt),
      ),
    );

  if (!pending) return { ok: false, reason: "Код не найден или уже использован" };
  if (pending.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "Код истёк. Отправьте боту новое сообщение" };
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId));
  if (!user || !user.isActive) return { ok: false, reason: "Учётная запись недоступна" };

  await db.transaction(async (tx) => {
    await tx
      .update(channelLinkCodesTable)
      .set({ claimedByUserId: userId, claimedAt: new Date() })
      .where(eq(channelLinkCodesTable.id, pending.id));

    // Re-linking the same messenger account moves it to the new owner.
    await tx
      .delete(channelIdentitiesTable)
      .where(
        and(
          eq(channelIdentitiesTable.channel, pending.channel),
          eq(channelIdentitiesTable.externalId, pending.externalId),
        ),
      );
    await tx.insert(channelIdentitiesTable).values({
      userId,
      channel: pending.channel,
      externalId: pending.externalId,
      displayName: pending.displayName,
      username: pending.username,
    });
  });

  logger.info(
    { channel: pending.channel, userId, externalId: pending.externalId },
    "Messenger account linked",
  );
  return { ok: true, userDisplayName: user.displayName, channel: pending.channel };
}

/** Unlinks a messenger account; the person loses bot access immediately. */
export async function unlinkIdentity(
  channel: MessengerChannel,
  externalId: string,
): Promise<boolean> {
  const removed = await db
    .delete(channelIdentitiesTable)
    .where(
      and(
        eq(channelIdentitiesTable.channel, channel),
        eq(channelIdentitiesTable.externalId, externalId),
      ),
    )
    .returning({ id: channelIdentitiesTable.id });
  return removed.length > 0;
}

/** The message an unlinked account receives. */
export function linkInstructions(channel: MessengerChannel, code: string, botName?: string) {
  const where =
    channel === "telegram"
      ? "в поле «Код из мессенджера»"
      : "в поле «Код из мессенджера»";
  return [
    "Этот аккаунт не привязан к складу, поэтому доступ закрыт.",
    "",
    `Код привязки: ${code}`,
    "",
    `Введите его ${where} на странице «Сотрудники» в веб-интерфейсе склада.`,
    "Код действует 30 минут. Если вы не сотрудник магазина — просто проигнорируйте это сообщение.",
    botName ? `\nБот: ${botName}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
