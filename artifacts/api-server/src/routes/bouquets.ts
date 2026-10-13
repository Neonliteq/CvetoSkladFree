import { randomUUID } from "node:crypto";
import { Router, type IRouter } from "express";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import {
  bouquetComponentsTable,
  db,
  movementBatchAllocationsTable,
  movementsTable,
  productionBatchesTable,
  productsTable,
  usersTable,
  type ProductionBatchIngredient,
} from "@workspace/db";
import { consumeBatchesFifo } from "../lib/inventory-batches";
import { money, recalculateProductFromBatches, salePrice } from "../lib/inventory-operations";
import { requireRole } from "../middlewares/auth";
import {
  CreateBouquetBody,
  CreateBouquetResponse,
  ListBouquetCategoriesResponse,
  ListBouquetStockBatchesQueryParams,
  ListBouquetStockBatchesResponse,
  ListBouquetsResponse,
  ListProductionBatchesQueryParams,
  ListProductionBatchesResponse,
  ProduceBouquetBody,
  ProduceBouquetParams,
  ProduceBouquetResponse,
  UpdateBouquetBody,
  UpdateBouquetParams,
  UpdateBouquetResponse,
} from "@workspace/api-zod";

const router: IRouter = Router();

/** Стоимость одной штуки по составу: и рецепт, и фактическая сборка считаются одинаково. */
const unitCostOf = (
  ingredients: Array<{ quantity: number; unitCost: number }>,
  quantity: number,
) =>
  money(
    ingredients.reduce((sum, item) => sum + item.quantity * item.unitCost, 0) /
      Math.max(quantity, 1),
  );

type ResolvedIngredient = ProductionBatchIngredient & { lineCost: number };

/**
 * Дополняет состав названиями, единицами и закупочной ценой.
 *
 * Заказчик присылает только товар и количество: цены берутся из базы, а не из
 * запроса, иначе итоговую себестоимость можно было бы подделать с клиента.
 * Один и тот же товар двумя строками складывается в одну — в сборке это
 * осмысленно, а в расчёте всё равно одна позиция. Читает через переданное
 * соединение: и рецепт, и сборка должны видеть один снимок данных.
 */
async function resolveIngredients(
  tx: any,
  ingredients: Array<{ productId: number; quantity: number }>,
): Promise<ResolvedIngredient[]> {
  const uniqueIds = [...new Set(ingredients.map((item) => item.productId))];
  const products = await tx
    .select()
    .from(productsTable)
    .where(inArray(productsTable.id, uniqueIds));
  if (products.length !== uniqueIds.length) {
    throw new Error("Один из компонентов не найден");
  }
  if (products.some((product: { productType: string }) => product.productType === "bouquet")) {
    throw new Error("Готовый букет нельзя использовать как компонент");
  }
  const archived = products.find((product: { archivedAt: Date | null }) => product.archivedAt);
  if (archived) {
    throw new Error(`Товар «${archived.name}» в архиве и не может быть в сборке`);
  }
  const quantities = new Map<number, number>();
  for (const item of ingredients) {
    quantities.set(item.productId, (quantities.get(item.productId) ?? 0) + item.quantity);
  }
  return [...quantities.entries()].map(([productId, quantity]) => {
    const product = products.find((candidate: { id: number }) => candidate.id === productId)!;
    const rounded = Math.round(quantity * 1000) / 1000;
    return {
      productId,
      productName: product.name,
      unit: product.unit,
      quantity: rounded,
      unitCost: product.averagePrice,
      lineCost: money(rounded * product.averagePrice),
    };
  });
}

/** Убирает лишние поля из строки БД и переводит снимок состава в ответ API. */
function toProductionBatch(
  row: typeof productionBatchesTable.$inferSelect,
  createdByName: string | null,
  remainingQuantity: number,
) {
  return {
    id: row.id,
    bouquetProductId: row.bouquetProductId,
    bouquetName: row.bouquetName,
    quantity: row.quantity,
    calculatedCost: row.calculatedCost,
    salePrice: row.salePrice,
    ingredients: row.ingredients.map((ingredient) => ({
      ...ingredient,
      lineCost: money(ingredient.quantity * ingredient.unitCost),
    })),
    createdAt: row.createdAt,
    createdByName,
    remainingQuantity,
  };
}

/**
 * Сколько букетов из каждой сборки ещё лежит на складе.
 *
 * Отдельной колонки для этого нет намеренно: остаток — это выпуск минус всё,
 * что со склада ушло (продажи, списания, вложения в другие сборки). Считать его
 * из движений надёжнее, чем хранить счётчик, который может разойтись с ними.
 */
async function loadBatchRemaining(
  tx: any,
  bouquetIds: number[],
): Promise<Map<string, number>> {
  const remaining = new Map<string, number>();
  if (!bouquetIds.length) return remaining;
  const produced = await tx
    .select({
      productionBatchId: movementsTable.productionBatchId,
      quantity: movementsTable.quantity,
    })
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.type, "production_output"),
        inArray(movementsTable.productId, bouquetIds),
        isNotNull(movementsTable.productionBatchId),
      ),
    );
  for (const row of produced) {
    if (row.productionBatchId) remaining.set(row.productionBatchId, row.quantity);
  }
  if (!remaining.size) return remaining;

  const consumedRows = await tx
    .select({
      productionBatchId: movementsTable.productionBatchId,
      quantity: movementBatchAllocationsTable.quantity,
    })
    .from(movementBatchAllocationsTable)
    // Связь идёт через операцию выпуска: она и есть партия сборки. Расход
    // ссылается на неё как на израсходованную партию.
    .innerJoin(
      movementsTable,
      eq(movementBatchAllocationsTable.receiptMovementId, movementsTable.id),
    )
    .where(
      and(
        inArray(movementsTable.type, ["production_output"]),
        inArray(movementsTable.productId, bouquetIds),
        isNotNull(movementsTable.productionBatchId),
      ),
    );
  for (const row of consumedRows) {
    if (!row.productionBatchId) continue;
    const left = (remaining.get(row.productionBatchId) ?? 0) - row.quantity;
    remaining.set(row.productionBatchId, Math.max(0, Math.round(left * 1000) / 1000));
  }
  return remaining;
}

/** Последние сборки букета: по ним видно, что реально ушло со склада и за сколько продали. */
async function loadProductionBatches(bouquetIds: number[], limitPerBouquet: number) {
  if (!bouquetIds.length) return [];
  const rows = await db
    .select()
    .from(productionBatchesTable)
    .where(inArray(productionBatchesTable.bouquetProductId, bouquetIds))
    .orderBy(desc(productionBatchesTable.createdAt), desc(productionBatchesTable.id));
  const authorIds = [
    ...new Set(rows.map((row) => row.createdBy).filter((id): id is number => id !== null)),
  ];
  const authors = authorIds.length
    ? await db
        .select({ id: usersTable.id, displayName: usersTable.displayName })
        .from(usersTable)
        .where(inArray(usersTable.id, authorIds))
    : [];
  const authorNames = new Map(authors.map((author) => [author.id, author.displayName]));
  const remaining = await loadBatchRemaining(db, bouquetIds);
  const perBouquet = new Map<number, typeof rows>();
  for (const row of rows) {
    const list = perBouquet.get(row.bouquetProductId) ?? [];
    if (list.length >= limitPerBouquet) continue;
    list.push(row);
    perBouquet.set(row.bouquetProductId, list);
  }
  return [...perBouquet.values()].flat().map((row) =>
    toProductionBatch(
      row,
      row.createdBy ? authorNames.get(row.createdBy) ?? null : null,
      remaining.get(row.id) ?? 0,
    ),
  );
}

async function loadBouquets() {
  const bouquets = await db
    .select()
    .from(productsTable)
    .where(and(eq(productsTable.productType, "bouquet"), isNull(productsTable.archivedAt)))
    .orderBy(asc(productsTable.name));
  if (!bouquets.length) return [];

  const recipeRows = await db
    .select({
      bouquetProductId: bouquetComponentsTable.bouquetProductId,
      productId: productsTable.id,
      productName: productsTable.name,
      unit: productsTable.unit,
      quantity: bouquetComponentsTable.quantity,
      unitCost: productsTable.averagePrice,
    })
    .from(bouquetComponentsTable)
    .innerJoin(
      productsTable,
      eq(bouquetComponentsTable.componentProductId, productsTable.id),
    )
    .where(
      inArray(
        bouquetComponentsTable.bouquetProductId,
        bouquets.map((bouquet) => bouquet.id),
      ),
    );

  // Последняя сборка нужна списку: рецепт — шаблон, а цена и состав последнего
  // букета показывают, что происходит в магазине на самом деле.
  const latest = await loadProductionBatches(
    bouquets.map((bouquet) => bouquet.id),
    1,
  );

  return bouquets.map((bouquet) => {
    const components = recipeRows
      .filter((row) => row.bouquetProductId === bouquet.id)
      .map(({ bouquetProductId: _, ...component }) => component);
    return {
      ...bouquet,
      components,
      calculatedCost: unitCostOf(components, 1),
      lastProduction: latest.find((batch) => batch.bouquetProductId === bouquet.id) ?? null,
    };
  });
}

async function validateComponents(
  components: Array<{ productId: number; quantity: number }>,
) {
  const uniqueIds = new Set(components.map((component) => component.productId));
  if (uniqueIds.size !== components.length) {
    throw new Error("Один компонент нельзя добавлять в состав дважды");
  }
  const products = await db
    .select()
    .from(productsTable)
    .where(inArray(productsTable.id, [...uniqueIds]));
  if (products.length !== uniqueIds.size) {
    throw new Error("Один из компонентов не найден");
  }
  if (products.some((product) => product.productType === "bouquet")) {
    throw new Error("Готовый букет нельзя использовать как компонент");
  }
  if (products.some((product) => product.archivedAt)) {
    const archived = products.find((product) => product.archivedAt)!;
    throw new Error(`Товар «${archived.name}» в архиве и не может быть в составе`);
  }
  return products;
}

router.get("/bouquets", async (_req, res): Promise<void> => {
  res.json(ListBouquetsResponse.parse(await loadBouquets()));
});

/**
 * Категории букетов для формы.
 *
 * Отдельно от склада: категории букетов («Свадебные», «На 8 марта») не должны
 * мешаться в списке категорий товаров. Отдаются по алфавиту — это подсказка, а
 * не данные отчёта.
 */
router.get("/bouquet-categories", async (_req, res): Promise<void> => {
  const rows = await db
    .selectDistinct({ category: productsTable.category })
    .from(productsTable)
    .where(eq(productsTable.productType, "bouquet"))
    .orderBy(asc(productsTable.category));
  res.json(ListBouquetCategoriesResponse.parse(rows.map((row) => row.category)));
});

router.get("/production-batches", async (req, res): Promise<void> => {
  const parsed = ListProductionBatchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверный запрос истории сборок" });
    return;
  }
  const [bouquet] = await db
    .select({ id: productsTable.id })
    .from(productsTable)
    .where(eq(productsTable.id, parsed.data.bouquetId));
  if (!bouquet) {
    res.status(404).json({ error: "Букет не найден" });
    return;
  }
  const rows = await loadProductionBatches([bouquet.id], parsed.data.limit ?? 20);
  res.json(ListProductionBatchesResponse.parse(rows));
});

router.get("/production-batches/stock", async (req, res): Promise<void> => {
  const parsed = ListBouquetStockBatchesQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "Неверный запрос сборок букета" });
    return;
  }
  const [bouquet] = await db
    .select()
    .from(productsTable)
    .where(eq(productsTable.id, parsed.data.bouquetId));
  if (!bouquet || bouquet.productType !== "bouquet") {
    res.status(404).json({ error: "Букет не найден" });
    return;
  }
  const batches = await loadProductionBatches([bouquet.id], 50);
  const outputs = await db
    .select({
      id: movementsTable.id,
      productionBatchId: movementsTable.productionBatchId,
    })
    .from(movementsTable)
    .where(
      and(
        eq(movementsTable.productId, bouquet.id),
        eq(movementsTable.type, "production_output"),
        isNotNull(movementsTable.productionBatchId),
      ),
    );
  const outputByBatch = new Map(
    outputs.map((row) => [row.productionBatchId as string, row.id]),
  );
  // На склад смотрит только то, что ещё не продано: остальное — история.
  const stock = batches
    .filter((batch) => batch.remainingQuantity > 0 && outputByBatch.has(batch.id))
    .map((batch) => ({
      ...batch,
      movementsId: outputByBatch.get(batch.id) as number,
    }));
  res.json(ListBouquetStockBatchesResponse.parse(stock));
});

router.post("/bouquets", requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = CreateBouquetBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const componentProducts = await validateComponents(parsed.data.components);
    const calculatedCost = money(
      parsed.data.components.reduce((sum, component) => {
        const product = componentProducts.find(
          (candidate) => candidate.id === component.productId,
        )!;
        return sum + component.quantity * product.averagePrice;
      }, 0),
    );
    const [bouquet] = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(productsTable)
        .values({
          name: parsed.data.name,
          // Категория букета приходит из формы; без неё — общая «Букеты».
          category: parsed.data.category?.trim() || "Букеты",
          productType: "bouquet",
          unit: "шт",
          // У букета нет минимального остатка: его собирают под заказ, а не
          // держат на полке, и «низкий остаток» по нему только шумит.
          minimumStock: 0,
          purchasePrice: calculatedCost,
          averagePrice: calculatedCost,
          markupPercent: parsed.data.markupPercent,
          salePrice: salePrice(calculatedCost, parsed.data.markupPercent),
          shelfLifeDays: 0,
        })
        .returning();
      await tx.insert(bouquetComponentsTable).values(
        parsed.data.components.map((component) => ({
          bouquetProductId: created.id,
          componentProductId: component.productId,
          quantity: component.quantity,
        })),
      );
      return [created];
    });
    const result = (await loadBouquets()).find((item) => item.id === bouquet.id)!;
    res.status(201).json(CreateBouquetResponse.parse(result));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось создать букет",
    });
  }
});

router.patch("/bouquets/:id", requireRole("admin"), async (req, res): Promise<void> => {
  const params = UpdateBouquetParams.safeParse(req.params);
  const body = UpdateBouquetBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Неверные данные букета" });
    return;
  }
  try {
    const componentProducts = await validateComponents(body.data.components);
    const calculatedCost = money(
      body.data.components.reduce((sum, component) => {
        const product = componentProducts.find(
          (candidate) => candidate.id === component.productId,
        )!;
        return sum + component.quantity * product.averagePrice;
      }, 0),
    );
    const updated = await db.transaction(async (tx) => {
      const [product] = await tx
        .update(productsTable)
        .set({
          name: body.data.name,
          category: body.data.category?.trim() || "Букеты",
          // Рецепт правится, но фактическая цена уже собранных букетов не
          // трогается: она записана в партии сборки.
          purchasePrice: calculatedCost,
          averagePrice: calculatedCost,
          markupPercent: body.data.markupPercent,
          salePrice: salePrice(calculatedCost, body.data.markupPercent),
        })
        .where(eq(productsTable.id, params.data.id))
        .returning();
      if (!product || product.productType !== "bouquet") {
        throw new Error("Букет не найден");
      }
      await tx
        .delete(bouquetComponentsTable)
        .where(eq(bouquetComponentsTable.bouquetProductId, product.id));
      await tx.insert(bouquetComponentsTable).values(
        body.data.components.map((component) => ({
          bouquetProductId: product.id,
          componentProductId: component.productId,
          quantity: component.quantity,
        })),
      );
      return product;
    });
    const result = (await loadBouquets()).find((item) => item.id === updated.id)!;
    res.json(UpdateBouquetResponse.parse(result));
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось обновить букет",
    });
  }
});

router.post("/bouquets/:id/produce", async (req, res): Promise<void> => {
  const params = ProduceBouquetParams.safeParse(req.params);
  const body = ProduceBouquetBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Неверное количество" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [bouquet] = await tx
        .select()
        .from(productsTable)
        .where(eq(productsTable.id, params.data.id));
      if (!bouquet || bouquet.productType !== "bouquet") {
        throw new Error("Букет не найден");
      }
      if (bouquet.archivedAt) {
        throw new Error("Букет в архиве. Верните его из архива, чтобы собирать");
      }
      // Состав берётся из запроса, если он передан: в работе цветок заменяют,
      // и списать со склада нужно именно то, что реально ушло в букет.
      const recipeRows = body.data.ingredients?.length
        ? null
        : await tx
            .select({
              productId: bouquetComponentsTable.componentProductId,
              quantity: bouquetComponentsTable.quantity,
            })
            .from(bouquetComponentsTable)
            .where(eq(bouquetComponentsTable.bouquetProductId, bouquet.id));
      const requested = body.data.ingredients?.length
        ? body.data.ingredients
        : recipeRows ?? [];
      if (!requested.length) throw new Error("У букета нет состава");
      const ingredients = await resolveIngredients(tx, requested);

      const quantity = body.data.quantity;
      const stockRows = await tx
        .select({ id: productsTable.id, currentStock: productsTable.currentStock })
        .from(productsTable)
        .where(
          inArray(
            productsTable.id,
            ingredients.map((item) => item.productId),
          ),
        );
      const stockById = new Map(stockRows.map((row) => [row.id, row.currentStock]));
      const missing = ingredients.filter(
        (item) => (stockById.get(item.productId) ?? 0) < item.quantity * quantity,
      );
      if (missing.length) {
        throw new Error(
          `Недостаточно: ${missing
            .map(
              (item) =>
                `${item.productName} (нужно ${money(item.quantity * quantity)} ${item.unit}, есть ${stockById.get(item.productId) ?? 0})`,
            )
            .join(", ")}`,
        );
      }

      const productionBatchId = randomUUID();
      // Себестоимость считается по средней закупочной цене — тому же числу,
      // которое видит интерфейс в снимке состава. Расход при этом идёт по
      // партиям склада (FIFO): списывается конкретный цветок, а не средний.
      let productionCost = 0;
      for (const ingredient of ingredients) {
        const consumed = ingredient.quantity * quantity;
        const allocations = await consumeBatchesFifo(tx, ingredient.productId, consumed);
        productionCost += consumed * ingredient.unitCost;
        const [updatedComponent] = await tx
          .update(productsTable)
          .set({ currentStock: sql`${productsTable.currentStock} - ${consumed}` })
          .where(
            and(
              eq(productsTable.id, ingredient.productId),
              gte(productsTable.currentStock, consumed),
            ),
          )
          .returning({ id: productsTable.id });
        if (!updatedComponent) {
          throw new Error(
            `Остаток «${ingredient.productName}» изменился. Проверьте наличие и повторите сборку`,
          );
        }
        const [movement] = await tx.insert(movementsTable).values({
          productId: ingredient.productId,
          productName: ingredient.productName,
          type: "production_input",
          quantity: consumed,
          unitPrice: ingredient.unitCost,
          reason: `Сборка: ${bouquet.name}`,
          productionBatchId,
          createdBy: req.user?.id,
        }).returning({ id: movementsTable.id });
        await tx.insert(movementBatchAllocationsTable).values(
          allocations.map((allocation) => ({
            movementId: movement.id,
            receiptMovementId: allocation.receiptMovementId,
            quantity: allocation.quantity,
          })),
        );
      }

      const productionCostPerUnit = money(productionCost / quantity);
      const [updatedBouquet] = await tx
        .update(productsTable)
        .set({
          currentStock: sql`${productsTable.currentStock} + ${quantity}`,
        })
        .where(eq(productsTable.id, bouquet.id))
        .returning();
      await tx.insert(movementsTable).values({
        productId: bouquet.id,
        productName: bouquet.name,
        type: "production_output",
        quantity,
        remainingQuantity: quantity,
        unitPrice: productionCostPerUnit,
        reason: "Производство готового товара",
        productionBatchId,
        batchArrivalDate: new Date().toISOString().slice(0, 10),
        createdBy: req.user?.id,
      });

      // Цена продажи: указанная сборщиком, иначе предложенная по наценке рецепта.
      const actualSalePrice =
        body.data.salePrice !== undefined
          ? money(body.data.salePrice)
          : salePrice(productionCostPerUnit, bouquet.markupPercent);
      const [batch] = await tx
        .insert(productionBatchesTable)
        .values({
          id: productionBatchId,
          bouquetProductId: bouquet.id,
          bouquetName: bouquet.name,
          quantity,
          calculatedCost: productionCostPerUnit,
          salePrice: actualSalePrice,
          ingredients: ingredients.map(({ lineCost: _, ...ingredient }) => ingredient),
          createdBy: req.user?.id,
        })
        .returning();

      // Себестоимость букета пересчитывается по партиям: фактическая сборка
      // могла стоить иначе, чем рецепт, и продажа должна списываться по факту.
      await recalculateProductFromBatches(tx, bouquet.id);

      return {
        bouquet: updatedBouquet,
        quantity,
        batch,
        consumed: ingredients.map((ingredient) => ({
          productId: ingredient.productId,
          productName: ingredient.productName,
          unit: ingredient.unit,
          quantity: ingredient.quantity * quantity,
          unitCost: ingredient.unitCost,
        })),
      };
    });
    const fullBouquet = (await loadBouquets()).find(
      (item) => item.id === result.bouquet.id,
    )!;
    res.json(
      ProduceBouquetResponse.parse({
        bouquet: fullBouquet,
        quantity: result.quantity,
        consumed: result.consumed,
        batch: toProductionBatch(result.batch, null, result.batch.quantity),
      }),
    );
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : "Не удалось собрать букет",
    });
  }
});

export default router;
