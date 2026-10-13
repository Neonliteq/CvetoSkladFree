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

export const userRole = pgEnum("user_role", ["admin", "staff"]);

/**
 * Staff accounts for a single shop.
 *
 * Passwords are stored as a bcrypt hash; the plain value never leaves the
 * request handler. `isActive` is the only way to revoke access — accounts are
 * never deleted, because stock movements reference them.
 */
export const usersTable = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    username: text("username").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    role: userRole("role").notNull().default("staff"),
    isActive: boolean("is_active").notNull().default(true),
    /**
     * The account created from the environment at startup. It cannot be
     * disabled, demoted or deleted from the interface — otherwise a shop could
     * lock itself out of its own warehouse.
     */
    isProtected: boolean("is_protected").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("users_username_unique").on(table.username)],
);

/**
 * Одноразовая ссылка на первый вход в новый магазин.
 *
 * Владелец сервиса заводит магазин и отдаёт его владельцу ссылку: тот сам задаёт логин и
 * пароль. Пароль нигде не пересылается и его не видит никто, кроме владельца, — это и
 * безопаснее, и снимает вопрос «а если сообщение перехватят».
 *
 * Хранится только хеш: дамп базы не даёт войти по чужой ссылке. `usedAt` делает ссылку
 * одноразовой, `expiresAt` — короткоживущей.
 */
export const setupTokensTable = pgTable(
  "setup_tokens",
  {
    id: serial("id").primaryKey(),
    tokenHash: text("token_hash").notNull(),
    /** Название магазина, для которого выдана ссылка. */
    shopName: text("shop_name").notNull(),
    /** Кто выдал ссылку — для журнала: видно, кто заводил магазин. */
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (table) => [uniqueIndex("setup_tokens_hash_unique").on(table.tokenHash)],
);

export type SetupToken = typeof setupTokensTable.$inferSelect;

/**
 * Browser sessions.
 *
 * Only the SHA-256 hash of the cookie value is stored, so a database dump does
 * not let anyone log in. Sessions live in the database rather than in a JWT
 * because access must be revocable immediately: disabling a user or revoking a
 * device has to take effect on the next request, not when a token expires.
 */
export const sessionsTable = pgTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    ip: text("ip"),
    /** Set when the session was opened through a trusted device. */
    deviceId: integer("device_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("sessions_token_hash_unique").on(table.tokenHash),
    index("sessions_user_idx").on(table.userId),
  ],
);

/**
 * Trusted warehouse device (a tablet that stays in the shop).
 *
 * The device token is deliberately long-lived but useless on its own: it only
 * allows the user picker and a PIN to be shown, it never grants access to data
 * and it cannot be used from another device.
 */
export const devicesTable = pgTable(
  "devices",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    tokenHash: text("token_hash").notNull(),
    userAgent: text("user_agent"),
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("devices_token_hash_unique").on(table.tokenHash),
    index("devices_user_idx").on(table.userId),
  ],
);

/** Short PIN for a trusted device; stored as a hash, never in clear text. */
export const devicePinsTable = pgTable(
  "device_pins",
  {
    userId: integer("user_id")
      .primaryKey()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    pinHash: text("pin_hash").notNull(),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

/**
 * Login audit: who signed in, from where, and who failed.
 *
 * Without this an incident ("who wrote off 300 roses") cannot be investigated
 * after the fact.
 */
export const authEventsTable = pgTable(
  "auth_events",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => usersTable.id, { onDelete: "set null" }),
    username: text("username"),
    event: text("event").notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    detail: text("detail"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_events_created_idx").on(table.createdAt)],
);

export type User = typeof usersTable.$inferSelect;
export type NewUser = typeof usersTable.$inferInsert;
export type Session = typeof sessionsTable.$inferSelect;
export type Device = typeof devicesTable.$inferSelect;
export type AuthEvent = typeof authEventsTable.$inferSelect;
