/**
 * Seeds the local database with a realistic starting assortment so the UI,
 * analytics and the AI assistant have something to work with.
 *
 * Usage (from the repository root, with DATABASE_URL available):
 *   pnpm --filter @workspace/scripts run seed
 *
 * The script is idempotent: it wipes the inventory tables and rebuilds them.
 *
 * Bookkeeping rules it follows — the same ones the API applies at runtime:
 *
 * 1. Every arrival is written with `remaining_quantity = quantity`, exactly like
 *    `addMovement` does. Receipts must never be inserted with a null
 *    `remaining_quantity`: `initializeLegacyBatches` would later distribute
 *    `products.current_stock` across the arrivals, which silently drops every
 *    unit that the seeded sales had already consumed.
 * 2. Sales and write-offs go through FIFO consumption, so their batch
 *    allocations and their cost match what the application would have recorded.
 * 3. `current_stock` and `average_price` are derived from the batches that are
 *    actually left, never hard-coded.
 */
import { randomUUID } from "node:crypto";
import {
  assistantConversationsTable,
  assistantMessagesTable,
  bouquetComponentsTable,
  db,
  movementBatchAllocationsTable,
  movementsTable,
  productionBatchesTable,
  productsTable,
  pool,
} from "@workspace/db";
import { eq, sql } from "drizzle-orm";
// Real FIFO implementation, shared with the API so the seed cannot drift from
// the runtime bookkeeping.
import { consumeBatchesFifo } from "@workspace/api-server/lib/inventory-batches";

const day = 86400000;
const today = new Date();
const iso = (offsetDays: number) =>
  new Date(today.getTime() - offsetDays * day).toISOString().slice(0, 10);
const at = (offsetDays: number, hour = 9) =>
  new Date(new Date(today.getTime() - offsetDays * day).setHours(hour, 0, 0, 0));
const round = (value: number) => Math.round(value * 100) / 100;

type ProductSeed = {
  name: string;
  aliases?: string[];
  category: string;
  variety?: string;
  color?: string;
  originCountry?: string;
  supplier?: string;
  unit: string;
  minimumStock: number;
  markupPercent: number;
  shelfLifeDays: number;
  /** Arrivals, oldest first. */
  arrivals: Array<{ daysAgo: number; quantity: number; unitPrice: number }>;
  /** Sales, oldest first. */
  sales?: Array<{ daysAgo: number; quantity: number; saleUnitPrice: number }>;
  /** Write-offs, oldest first. */
  writeoffs?: Array<{ daysAgo: number; quantity: number; reason: string }>;
};

const products: ProductSeed[] = [
  {
    name: "Роза Эквадор красная",
    aliases: ["розы красные", "красная роза", "роза красная"],
    category: "Цветы",
    variety: "Freedom",
    color: "Красный",
    originCountry: "Эквадор",
    supplier: "ЦветТорг",
    unit: "стебель",
    minimumStock: 100,
    markupPercent: 120,
    shelfLifeDays: 10,
    arrivals: [
      // Две давние поставки — чтобы у сравнения с прошлым периодом были данные:
      // без них «+18% к прошлому периоду» показывать не на чем.
      { daysAgo: 26, quantity: 180, unitPrice: 84 },
      { daysAgo: 12, quantity: 190, unitPrice: 86 },
      { daysAgo: 9, quantity: 200, unitPrice: 88 },
      { daysAgo: 4, quantity: 240, unitPrice: 95 },
    ],
    sales: [
      { daysAgo: 24, quantity: 55, saleUnitPrice: 185 },
      { daysAgo: 13, quantity: 48, saleUnitPrice: 190 },
      { daysAgo: 6, quantity: 60, saleUnitPrice: 209 },
      { daysAgo: 3, quantity: 40, saleUnitPrice: 209 },
    ],
    writeoffs: [{ daysAgo: 2, quantity: 18, reason: "Увядшие стебли" }],
  },
  {
    name: "Роза Кения белая",
    aliases: ["розы белые", "белая роза"],
    category: "Цветы",
    variety: "Avalanche",
    color: "Белый",
    originCountry: "Кения",
    supplier: "ЦветТорг",
    unit: "стебель",
    minimumStock: 80,
    markupPercent: 120,
    shelfLifeDays: 9,
    arrivals: [{ daysAgo: 5, quantity: 150, unitPrice: 88 }],
    sales: [{ daysAgo: 2, quantity: 35, saleUnitPrice: 194 }],
  },
  {
    name: "Хризантема белая",
    aliases: ["хризантема", "хризантемы"],
    category: "Цветы",
    variety: "Baltika",
    color: "Белый",
    originCountry: "Голландия",
    supplier: "Флора Импорт",
    unit: "шт",
    minimumStock: 60,
    markupPercent: 110,
    shelfLifeDays: 12,
    arrivals: [{ daysAgo: 8, quantity: 120, unitPrice: 62 }],
    sales: [{ daysAgo: 1, quantity: 18, saleUnitPrice: 130 }],
  },
  {
    name: "Гипсофила белая",
    aliases: ["гипсофила"],
    category: "Цветы",
    color: "Белый",
    originCountry: "Израиль",
    supplier: "Флора Импорт",
    unit: "упак.",
    minimumStock: 15,
    markupPercent: 100,
    shelfLifeDays: 14,
    arrivals: [{ daysAgo: 7, quantity: 25, unitPrice: 310 }],
    sales: [{ daysAgo: 2, quantity: 6, saleUnitPrice: 620 }],
  },
  {
    name: "Эустома розовая",
    aliases: ["эустома", "лизиантус"],
    category: "Цветы",
    color: "Розовый",
    originCountry: "Колумбия",
    supplier: "ЦветТорг",
    unit: "стебель",
    minimumStock: 40,
    markupPercent: 115,
    shelfLifeDays: 11,
    arrivals: [{ daysAgo: 3, quantity: 90, unitPrice: 74 }],
    sales: [{ daysAgo: 1, quantity: 12, saleUnitPrice: 159 }],
  },
  {
    name: "Эвкалипт",
    aliases: ["эвкалипт"],
    category: "Зелень",
    color: "Зелёный",
    originCountry: "Голландия",
    supplier: "Флора Импорт",
    unit: "упак.",
    minimumStock: 10,
    markupPercent: 130,
    shelfLifeDays: 21,
    arrivals: [{ daysAgo: 6, quantity: 18, unitPrice: 180 }],
    sales: [{ daysAgo: 2, quantity: 5, saleUnitPrice: 414 }],
  },
  {
    name: "Рускус итальянский",
    aliases: ["рускус"],
    category: "Зелень",
    color: "Зелёный",
    originCountry: "Италия",
    supplier: "Флора Импорт",
    unit: "упак.",
    minimumStock: 8,
    markupPercent: 120,
    shelfLifeDays: 20,
    arrivals: [{ daysAgo: 6, quantity: 12, unitPrice: 240 }],
  },
  {
    name: "Лента атласная пудровая",
    aliases: ["лента", "лента атласная", "пудровая лента"],
    category: "Упаковка",
    color: "Пудровый",
    supplier: "УпакСервис",
    unit: "м",
    minimumStock: 30,
    markupPercent: 150,
    shelfLifeDays: 0,
    arrivals: [
      { daysAgo: 12, quantity: 50, unitPrice: 12 },
      { daysAgo: 2, quantity: 18, unitPrice: 13 },
    ],
    sales: [{ daysAgo: 1, quantity: 25, saleUnitPrice: 30 }],
  },
  {
    name: "Бумага крафт для букета",
    aliases: ["крафт", "бумага крафт"],
    category: "Упаковка",
    color: "Коричневый",
    supplier: "УпакСервис",
    unit: "рулон",
    minimumStock: 6,
    markupPercent: 90,
    shelfLifeDays: 0,
    arrivals: [{ daysAgo: 10, quantity: 12, unitPrice: 450 }],
    sales: [{ daysAgo: 3, quantity: 4, saleUnitPrice: 855 }],
  },
  {
    name: "Плёнка прозрачная матовая",
    aliases: ["плёнка", "пленка"],
    category: "Упаковка",
    supplier: "УпакСервис",
    unit: "рулон",
    minimumStock: 4,
    markupPercent: 100,
    shelfLifeDays: 0,
    arrivals: [{ daysAgo: 10, quantity: 8, unitPrice: 380 }],
  },
  {
    name: "Оазис флористический",
    aliases: ["оазис", "пиафлор"],
    category: "Расходники",
    supplier: "Флора Импорт",
    unit: "шт",
    minimumStock: 10,
    markupPercent: 120,
    shelfLifeDays: 0,
    arrivals: [{ daysAgo: 11, quantity: 20, unitPrice: 95 }],
    sales: [{ daysAgo: 4, quantity: 6, saleUnitPrice: 209 }],
  },
  {
    name: "Шпагат джутовый",
    aliases: ["шпагат", "джут"],
    category: "Расходники",
    supplier: "УпакСервис",
    unit: "м",
    minimumStock: 20,
    markupPercent: 150,
    shelfLifeDays: 0,
    arrivals: [{ daysAgo: 12, quantity: 100, unitPrice: 6 }],
    sales: [{ daysAgo: 5, quantity: 25, saleUnitPrice: 15 }],
  },
  {
    name: "Коробка подарочная средняя",
    aliases: ["коробка", "коробка подарочная"],
    category: "Коробки",
    color: "Крафт",
    supplier: "УпакСервис",
    unit: "шт",
    minimumStock: 15,
    markupPercent: 110,
    shelfLifeDays: 0,
    arrivals: [{ daysAgo: 9, quantity: 30, unitPrice: 210 }],
    sales: [{ daysAgo: 3, quantity: 9, saleUnitPrice: 441 }],
  },
  {
    name: "Коробка подарочная большая",
    aliases: ["большая коробка"],
    category: "Коробки",
    color: "Чёрный",
    supplier: "УпакСервис",
    unit: "шт",
    minimumStock: 8,
    markupPercent: 105,
    shelfLifeDays: 0,
    arrivals: [{ daysAgo: 9, quantity: 16, unitPrice: 340 }],
  },
];

const bouquet = {
  name: "Букет «Утро»",
  minimumStock: 1,
  markupPercent: 90,
  quantity: 2,
  components: [
    { productName: "Роза Эквадор красная", quantity: 7 },
    { productName: "Хризантема белая", quantity: 3 },
    { productName: "Эвкалипт", quantity: 1 },
    { productName: "Лента атласная пудровая", quantity: 2 },
  ],
};

const salePriceOf = (cost: number, markupPercent: number) =>
  round(cost * (1 + markupPercent / 100));

/** Creates the movement, removes the units from the batches and returns its cost. */
async function recordOutflow(input: {
  productId: number;
  productName: string;
  type: "expense" | "writeoff" | "production_input";
  quantity: number;
  reason: string;
  saleUnitPrice?: number;
  productionBatchId?: string;
  createdAt: Date;
}) {
  const allocations = await consumeBatchesFifo(db, input.productId, input.quantity);
  const cost = round(
    allocations.reduce(
      (sum, allocation) => sum + allocation.quantity * allocation.unitPrice,
      0,
    ),
  );
  const [movement] = await db
    .insert(movementsTable)
    .values({
      productId: input.productId,
      productName: input.productName,
      type: input.type,
      quantity: input.quantity,
      unitPrice: input.quantity > 0 ? round(cost / input.quantity) : 0,
      saleUnitPrice: input.saleUnitPrice ?? null,
      // A receipt carries the markup of its position, so the card in the UI can
      // show and edit it. The seed knows the product, so it records the same
      // value the real flow would.
      reason: input.reason,
      productionBatchId: input.productionBatchId ?? null,
      createdAt: input.createdAt,
    })
    .returning({ id: movementsTable.id });
  await db.insert(movementBatchAllocationsTable).values(
    allocations.map((allocation) => ({
      movementId: movement.id,
      receiptMovementId: allocation.receiptMovementId,
      quantity: allocation.quantity,
    })),
  );
  return cost;
}

/** Recomputes stock, weighted average cost and sale price from the open batches. */
async function refreshProduct(productId: number) {
  const [product] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, productId));
  const batches = await db
    .select({
      remainingQuantity: movementsTable.remainingQuantity,
      unitPrice: movementsTable.unitPrice,
    })
    .from(movementsTable)
    .where(eq(movementsTable.productId, productId));
  const stock = batches.reduce((sum, batch) => sum + (batch.remainingQuantity ?? 0), 0);
  const value = batches.reduce(
    (sum, batch) => sum + (batch.remainingQuantity ?? 0) * batch.unitPrice,
    0,
  );
  const averagePrice = stock > 0 ? value / stock : 0;
  await db
    .update(productsTable)
    .set({
      currentStock: round(stock),
      averagePrice: round(averagePrice),
      purchasePrice: round(averagePrice),
      salePrice: salePriceOf(averagePrice, product.markupPercent),
    })
    .where(eq(productsTable.id, productId));
}

async function main() {
  console.log("Clearing existing inventory data…");
  await db.delete(assistantMessagesTable);
  await db.delete(assistantConversationsTable);
  await db.delete(movementBatchAllocationsTable);
  await db.delete(productionBatchesTable);
  await db.delete(movementsTable);
  await db.delete(bouquetComponentsTable);
  await db.delete(productsTable);

  const productIds = new Map<string, number>();

  console.log("Writing arrivals…");
  for (const seed of products) {
    const [row] = await db
      .insert(productsTable)
      .values({
        name: seed.name,
        aliases: seed.aliases ?? [],
        category: seed.category,
        productType: "stock",
        variety: seed.variety ?? null,
        color: seed.color ?? null,
        originCountry: seed.originCountry ?? null,
        supplier: seed.supplier ?? null,
        unit: seed.unit,
        minimumStock: seed.minimumStock,
        markupPercent: seed.markupPercent,
        shelfLifeDays: seed.shelfLifeDays,
        currentStock: 0,
        averagePrice: 0,
        purchasePrice: 0,
        salePrice: 0,
        createdAt: at(20),
      })
      .returning({ id: productsTable.id });
    productIds.set(seed.name, row.id);

    for (const [index, arrival] of seed.arrivals.entries()) {
      await db.insert(movementsTable).values({
        productId: row.id,
        productName: seed.name,
        type: "receipt",
        quantity: arrival.quantity,
        // Never null: a null would make the legacy initializer redistribute
        // current_stock across the arrivals and lose the consumed units.
        remainingQuantity: arrival.quantity,
        unitPrice: arrival.unitPrice,
        // Каждый приход хранит наценку позиции: карточка прихода показывает её
        // и позволяет править, а демо-данные должны выглядеть как настоящие.
        markupPercent: seed.markupPercent,
        previousMarkupPercent: seed.markupPercent,
        reason: `Поставка ${seed.supplier ?? "поставщик"}`,
        orderNumber: `П-${1000 + row.id * 10 + index}`,
        batchArrivalDate: iso(arrival.daysAgo),
        cutDate: seed.shelfLifeDays ? iso(arrival.daysAgo) : null,
        expiresAt: seed.shelfLifeDays
          ? iso(arrival.daysAgo - seed.shelfLifeDays)
          : null,
        createdAt: at(arrival.daysAgo, 8),
      });
    }
  }

  console.log("Writing sales and write-offs…");
  for (const seed of products) {
    const productId = productIds.get(seed.name)!;
    for (const sale of seed.sales ?? []) {
      await recordOutflow({
        productId,
        productName: seed.name,
        type: "expense",
        quantity: sale.quantity,
        reason: "Продажа в зале",
        saleUnitPrice: sale.saleUnitPrice,
        createdAt: at(sale.daysAgo, 15),
      });
    }
    for (const writeoff of seed.writeoffs ?? []) {
      await recordOutflow({
        productId,
        productName: seed.name,
        type: "writeoff",
        quantity: writeoff.quantity,
        reason: writeoff.reason,
        createdAt: at(writeoff.daysAgo, 18),
      });
    }
    await refreshProduct(productId);
    const [product] = await db
      .select({
        currentStock: productsTable.currentStock,
        averagePrice: productsTable.averagePrice,
        unit: productsTable.unit,
      })
      .from(productsTable)
      .where(eq(productsTable.id, productId));
    console.log(
      `  ${seed.name}: ${product.currentStock} ${product.unit} по ${product.averagePrice} ₽`,
    );
  }

  console.log("Creating the bouquet and assembling it…");
  const componentCost = round(
    (
      await Promise.all(
        bouquet.components.map(async (component) => {
          const [product] = await db
            .select({ averagePrice: productsTable.averagePrice })
            .from(productsTable)
            .where(eq(productsTable.name, component.productName));
          return product.averagePrice * component.quantity;
        }),
      )
    ).reduce((sum, value) => sum + value, 0),
  );
  const [bouquetRow] = await db
    .insert(productsTable)
    .values({
      name: bouquet.name,
      aliases: [],
      category: "Букеты",
      productType: "bouquet",
      unit: "шт",
      minimumStock: bouquet.minimumStock,
      purchasePrice: componentCost,
      averagePrice: componentCost,
      markupPercent: bouquet.markupPercent,
      salePrice: salePriceOf(componentCost, bouquet.markupPercent),
      shelfLifeDays: 5,
      currentStock: 0,
      createdAt: at(15),
    })
    .returning({ id: productsTable.id });

  await db.insert(bouquetComponentsTable).values(
    bouquet.components.map((component) => ({
      bouquetProductId: bouquetRow.id,
      componentProductId: productIds.get(component.productName)!,
      quantity: component.quantity,
    })),
  );

  const productionBatchId = randomUUID();
  let productionCost = 0;
  for (const component of bouquet.components) {
    const productId = productIds.get(component.productName)!;
    productionCost += await recordOutflow({
      productId,
      productName: component.productName,
      type: "production_input",
      quantity: component.quantity * bouquet.quantity,
      reason: `Сборка: ${bouquet.name}`,
      productionBatchId,
      createdAt: at(2, 11),
    });
    await refreshProduct(productId);
  }

  const bouquetUnitCost = round(productionCost / bouquet.quantity);
  await db.insert(movementsTable).values({
    productId: bouquetRow.id,
    productName: bouquet.name,
    type: "production_output",
    quantity: bouquet.quantity,
    remainingQuantity: bouquet.quantity,
    unitPrice: bouquetUnitCost,
    reason: "Производство готового товара",
    productionBatchId,
    batchArrivalDate: iso(2),
    createdAt: at(2, 11),
  });
  // Партия сборки: состав и цена, по которой букет реально собрали.
  const seededComponents = await db
    .select({ id: productsTable.id, name: productsTable.name, unit: productsTable.unit, averagePrice: productsTable.averagePrice })
    .from(productsTable);
  const componentByName = new Map(seededComponents.map((item) => [item.name, item]));
  await db.insert(productionBatchesTable).values({
    id: productionBatchId,
    bouquetProductId: bouquetRow.id,
    bouquetName: bouquet.name,
    quantity: bouquet.quantity,
    calculatedCost: bouquetUnitCost,
    salePrice: salePriceOf(componentCost, bouquet.markupPercent),
    ingredients: bouquet.components.map((component) => {
      const row = componentByName.get(component.productName)!;
      return {
        productId: row.id,
        productName: row.name,
        unit: row.unit,
        quantity: component.quantity,
        unitCost: row.averagePrice,
      };
    }),
    createdAt: at(2, 11),
  });
  await refreshProduct(bouquetRow.id);

  const counts = await db.execute(sql`
    select
      (select count(*) from products) as products,
      (select count(*) from stock_movements) as movements,
      (select count(*) from movement_batch_allocations) as allocations,
      (select sum(current_stock) from products) as total_units,
      (select sum(current_stock * average_price) from products) as inventory_value
  `);
  console.log("Done:", counts.rows[0]);
  await pool.end();
}

main().catch(async (error) => {
  console.error(error);
  await pool.end();
  process.exit(1);
});
