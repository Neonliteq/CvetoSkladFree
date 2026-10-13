import {
  AnyPgColumn,
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { usersTable } from "./auth";

export const movementType = pgEnum("movement_type", [
  "receipt",
  "expense",
  "writeoff",
  "transfer",
  "production_input",
  "production_output",
]);

export const productType = pgEnum("product_type", ["stock", "bouquet"]);

export const productsTable = pgTable("products", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  aliases: text("aliases").array().notNull().default(sql`'{}'::text[]`),
  category: text("category").notNull(),
  productType: productType("product_type").notNull().default("stock"),
  variety: text("variety"),
  color: text("color"),
  originCountry: text("origin_country"),
  supplier: text("supplier"),
  unit: text("unit").notNull().default("шт"),
  currentStock: numeric("current_stock", { mode: "number" }).notNull().default(0),
  minimumStock: numeric("minimum_stock", { mode: "number" }).notNull().default(0),
  purchasePrice: numeric("purchase_price", { mode: "number" }).notNull().default(0),
  averagePrice: numeric("average_price", { mode: "number" }).notNull().default(0),
  markupPercent: numeric("markup_percent", { mode: "number" }).notNull().default(0),
  salePrice: numeric("sale_price", { mode: "number" }).notNull().default(0),
  shelfLifeDays: numeric("shelf_life_days", { mode: "number" }).notNull().default(0),
  /**
   * Дата переноса в архив. Удалять товар с историей операций нельзя — ломается
   * аналитика, поэтому ненужные позиции убираются из списка, но остаются в базе
   * вместе со своей историей.
   */
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const movementsTable = pgTable(
  "stock_movements",
  {
    id: serial("id").primaryKey(),
    productId: numeric("product_id", { mode: "number" }).notNull(),
    productName: text("product_name").notNull(),
    type: movementType("type").notNull(),
    quantity: numeric("quantity", { mode: "number" }).notNull(),
    remainingQuantity: numeric("remaining_quantity", { mode: "number" }),
    unitPrice: numeric("unit_price", { mode: "number" }).notNull().default(0),
    saleUnitPrice: numeric("sale_unit_price", { mode: "number" }),
    /**
     * Markup of the position when the operation was recorded. It lives on the
     * product, but a receipt carries a copy so its card can show and correct it
     * without a second lookup.
     */
    markupPercent: numeric("markup_percent", { mode: "number" }).notNull().default(0),
    previousPurchasePrice: numeric("previous_purchase_price", { mode: "number" }),
    previousMarkupPercent: numeric("previous_markup_percent", { mode: "number" }),
    reason: text("reason").notNull().default("Операция склада"),
    /**
     * Marks an operation that must not reach the statistics: a position added by
     * mistake, a recount, a write-off of something that never existed in the
     * shop's books. The stock still changes, the history still shows it, but
     * revenue, cost, profit and the movement charts skip it — otherwise a typo
     * would live in the reports forever.
     */
    excludeFromStats: boolean("exclude_from_stats").notNull().default(false),
    orderNumber: text("order_number"),
    productionBatchId: text("production_batch_id"),
    /**
     * Set when the movement was written as one position of a composite
     * assistant command: every position of one command shares the id, so the
     * whole set can be reverted together.
     */
    assistantBatchId: text("assistant_batch_id"),
    batchArrivalDate: date("batch_arrival_date", { mode: "string" }),
    cutDate: date("cut_date", { mode: "string" }),
    expiresAt: date("expires_at", { mode: "string" }),
    reversalOfMovementId: integer("reversal_of_movement_id").references(
      (): AnyPgColumn => movementsTable.id,
      { onDelete: "restrict" },
    ),
    /**
     * Author of the operation. Nullable for the movements recorded before
     * accounts existed; every new operation fills it in.
     */
    createdBy: integer("created_by").references(() => usersTable.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("stock_movements_reversal_once_idx")
      .on(table.reversalOfMovementId)
      .where(sql`${table.reversalOfMovementId} is not null`),
    check(
      "remaining_quantity_bounds",
      sql`${table.remainingQuantity} is null or (${table.remainingQuantity} >= 0 and ${table.remainingQuantity} <= ${table.quantity})`,
    ),
  ],
);

export const bouquetComponentsTable = pgTable("bouquet_components", {
  id: serial("id").primaryKey(),
  bouquetProductId: integer("bouquet_product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  componentProductId: integer("component_product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "restrict" }),
  quantity: numeric("quantity", { mode: "number" }).notNull(),
});

/** Одна позиция фактического состава сборки: снимок на момент производства. */
export type ProductionBatchIngredient = {
  productId: number;
  productName: string;
  unit: string;
  quantity: number;
  unitCost: number;
};

/**
 * Партия собранных букетов.
 *
 * Рецепт — это шаблон, а в работе цветок часто заменяют и цену ставят по факту.
 * Поэтому состав и цена продажи хранятся у каждой сборки: по ним видно, что
 * реально ушло со склада и за сколько букет продали, а сам рецепт не портится.
 */
export const productionBatchesTable = pgTable("production_batches", {
  id: text("id").primaryKey(),
  bouquetProductId: integer("bouquet_product_id")
    .notNull()
    .references(() => productsTable.id, { onDelete: "cascade" }),
  bouquetName: text("bouquet_name").notNull(),
  quantity: numeric("quantity", { mode: "number" }).notNull(),
  calculatedCost: numeric("calculated_cost", { mode: "number" }).notNull().default(0),
  salePrice: numeric("sale_price", { mode: "number" }).notNull().default(0),
  ingredients: jsonb("ingredients")
    .$type<ProductionBatchIngredient[]>()
    .notNull()
    .default(sql`'[]'::jsonb`),
  createdBy: integer("created_by").references(() => usersTable.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const movementBatchAllocationsTable = pgTable(
  "movement_batch_allocations",
  {
    id: serial("id").primaryKey(),
    movementId: integer("movement_id")
      .notNull()
      .references(() => movementsTable.id, { onDelete: "cascade" }),
    receiptMovementId: integer("receipt_movement_id")
      .notNull()
      .references(() => movementsTable.id, { onDelete: "restrict" }),
    quantity: numeric("quantity", { mode: "number" }).notNull(),
  },
  (table) => [
    check("movement_batch_allocation_quantity_positive", sql`${table.quantity} > 0`),
  ],
);

export type Product = typeof productsTable.$inferSelect;
export type Movement = typeof movementsTable.$inferSelect;
export type BouquetComponent = typeof bouquetComponentsTable.$inferSelect;
export type ProductionBatch = typeof productionBatchesTable.$inferSelect;
export type MovementBatchAllocation =
  typeof movementBatchAllocationsTable.$inferSelect;