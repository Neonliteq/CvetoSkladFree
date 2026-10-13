import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { usersTable } from "./auth";

export const messengerChannel = pgEnum("messenger_channel", ["telegram", "max"]);

/**
 * Account of a messenger user, linked to a staff account.
 *
 * A messenger gives no password, so access is decided by this table alone: an
 * unknown `external_id` is a stranger and gets nothing but a linking offer.
 */
export const channelIdentitiesTable = pgTable(
  "channel_identities",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    channel: messengerChannel("channel").notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    username: text("username"),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
  },
  (table) => [
    uniqueIndex("channel_identities_channel_external_unique").on(
      table.channel,
      table.externalId,
    ),
    index("channel_identities_user_idx").on(table.userId),
  ],
);

/**
 * One-time codes that link a messenger account to a staff account.
 *
 * Only the hash is stored, so a database dump cannot be used to hijack a link,
 * and a code stops working the moment it is claimed.
 */
export const channelLinkCodesTable = pgTable(
  "channel_link_codes",
  {
    id: serial("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    channel: messengerChannel("channel").notNull(),
    externalId: text("external_id").notNull(),
    displayName: text("display_name"),
    username: text("username"),
    claimedByUserId: integer("claimed_by_user_id").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("channel_link_codes_hash_unique").on(table.codeHash)],
);

export type ChannelIdentity = typeof channelIdentitiesTable.$inferSelect;
export type MessengerChannel = (typeof messengerChannel.enumValues)[number];
