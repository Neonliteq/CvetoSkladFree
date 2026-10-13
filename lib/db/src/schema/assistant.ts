import { integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { usersTable } from "./auth";
import { movementsTable } from "./products";

export const assistantConversationsTable = pgTable("assistant_conversations", {
  id: text("id").primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assistantMessagesTable = pgTable("assistant_messages", {
  id: serial("id").primaryKey(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => assistantConversationsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  action: text("action"),
  movementId: integer("movement_id").references(() => movementsTable.id, {
    onDelete: "set null",
  }),
  /**
   * JSON payload attached to a message. Invoice recognition stores the review
   * draft here so the confirmation card can be restored on reload.
   */
  invoiceMetadata: text("invoice_metadata"),
  /**
   * Неподтверждённый разбор команды.
   *
   * Хранится на сервере, а не только в браузере: в мессенджере нет карточки с
   * кнопкой «Провести», и подтвердить разбор можно только следующим сообщением.
   * Здесь же лежит план, к которому относится ответ пользователя («да» или
   * выбор товара из списка).
   */
  pendingPlan: text("pending_plan"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AssistantConversation = typeof assistantConversationsTable.$inferSelect;
export type AssistantMessage = typeof assistantMessagesTable.$inferSelect;

/**
 * Настройки AI-провайдера, заданные администратором в интерфейсе.
 *
 * Строка ровно одна (`id = 1`): магазин один, и «набор провайдеров» здесь не
 * нужен. Пустое поле означает «не задано» — тогда в дело идёт значение из
 * окружения, поэтому система работает и без настроек в базе.
 */
export const aiSettingsTable = pgTable("ai_settings", {
  id: integer("id").primaryKey().default(1),
  baseUrl: text("base_url"),
  apiKey: text("api_key"),
  model: text("model"),
  updatedBy: integer("updated_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AiSettings = typeof aiSettingsTable.$inferSelect;