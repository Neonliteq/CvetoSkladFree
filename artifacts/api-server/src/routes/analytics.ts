import { Router, type IRouter } from "express";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  movementBatchAllocationsTable,
  movementsTable,
  productsTable,
} from "@workspace/db";
import {
  GetMovementAnalyticsQueryParams,
  GetMovementAnalyticsResponse,
} from "@workspace/api-zod";
import { calculateSalesFinancials } from "../lib/financial-analytics";
import {
  enumerateLocalDays,
  localDateOnly,
  localDayKey,
} from "../lib/local-day";

const router: IRouter = Router();
const dateOnly = (value: Date | string | undefined) =>
  value instanceof Date ? localDateOnly(value) : value;

router.get("/analytics/movements", async (req, res): Promise<void> => {
  const parsed = GetMovementAnalyticsQueryParams.safeParse({
    ...req.query,
    from:
      typeof req.query.from === "string" ? new Date(req.query.from) : req.query.from,
    to: typeof req.query.to === "string" ? new Date(req.query.to) : req.query.to,
  });
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { productId, category, type, breakdown } = parsed.data;
  const from = dateOnly(parsed.data.from);
  const to = dateOnly(parsed.data.to);
  // Фильтры по товару, категории и виду операции — общие для выбранного и
  // прошлого периода: сравнение «яблоки с яблоками».
  const filters = [
    productId ? eq(movementsTable.productId, productId) : undefined,
    category ? eq(productsTable.category, category) : undefined,
    type ? eq(movementsTable.type, type) : undefined,
  ].filter(Boolean);
  const where = filters.length ? and(...filters) : undefined;

  // Границы дня — по календарю магазина, а не по UTC: иначе операции после
  // полуночи попадают в предыдущий день. Прошлый период считается тем же
  // запросом и разбирается по датам в памяти: движений на магазин немного, а
  // второй запрос дублировал бы фильтры.
  const rows = await db
    .select({
      id: movementsTable.id,
      productId: movementsTable.productId,
      productName: movementsTable.productName,
      category: productsTable.category,
      type: movementsTable.type,
      quantity: movementsTable.quantity,
      unitPrice: movementsTable.unitPrice,
      saleUnitPrice: movementsTable.saleUnitPrice,
      reversalOfMovementId: movementsTable.reversalOfMovementId,
      excludeFromStats: movementsTable.excludeFromStats,
      createdAt: movementsTable.createdAt,
    })
    .from(movementsTable)
    .innerJoin(productsTable, eq(movementsTable.productId, productsTable.id))
    .where(where)
    .orderBy(asc(movementsTable.createdAt));

  const reversalRows = await db
    .select({ reversalOfMovementId: movementsTable.reversalOfMovementId })
    .from(movementsTable);
  const reversedIds = new Set(
    reversalRows
      .map((row) => row.reversalOfMovementId)
      .filter((id): id is number => id !== null),
  );
  // Отменённые операции и операции, помеченные «не учитывать в статистике», в
  // расчёт не идут. Второе — для позиций, добавленных по ошибке: остаток такой
  // расход меняет, а выручка и себестоимость от него портиться не должны.
  const allActive = rows.filter(
    (row) =>
      row.reversalOfMovementId === null &&
      !reversedIds.has(row.id) &&
      !row.excludeFromStats,
  );
  const inRange = (row: (typeof allActive)[number], start: string, end: string) => {
    const day = localDayKey(row.createdAt);
    return day >= start && day <= end;
  };
  const activeRows = from && to ? allActive.filter((row) => inRange(row, from, to)) : allActive;

  /**
   * Прошлый период той же длины.
   *
   * Нужен, чтобы «47 496 ₽» не висело без контекста: рядом с итогом видно, вырос
   * магазин или упал. Период считается по календарным дням, поэтому длина берётся
   * из перечисления дат, а не из разницы отметок времени.
   */
  const previousPeriod = (() => {
    if (!from || !to) return null;
    const days = enumerateLocalDays(from, to);
    if (!days.length) return null;
    const start = new Date(`${from}T12:00:00`);
    start.setDate(start.getDate() - days.length);
    const end = new Date(`${from}T12:00:00`);
    end.setDate(end.getDate() - 1);
    return { from: localDayKey(start), to: localDayKey(end) };
  })();
  const previousRows = previousPeriod
    ? allActive.filter((row) => inRange(row, previousPeriod.from, previousPeriod.to))
    : [];
  const previousAllocations = previousRows.length
    ? await db
        .select({
          movementId: movementBatchAllocationsTable.movementId,
          quantity: movementBatchAllocationsTable.quantity,
          receiptUnitPrice: movementsTable.unitPrice,
        })
        .from(movementBatchAllocationsTable)
        .innerJoin(
          movementsTable,
          eq(movementBatchAllocationsTable.receiptMovementId, movementsTable.id),
        )
        .where(
          inArray(
            movementBatchAllocationsTable.movementId,
            previousRows
              .filter((row) => row.type === "expense" || row.type === "writeoff")
              .map((row) => row.id),
          ),
        )
    : [];

  const expenseRows = activeRows.filter((row) => row.type === "expense");
  // Себестоимость нужна и продажам, и списаниям: у обоих товар уходит со склада,
  // но выручку дают только продажи. Разбор строится по обоим видам, иначе по
  // списанию не видно, сколько денег ушло в мусор.
  const costRows = activeRows.filter(
    (row) => row.type === "expense" || row.type === "writeoff",
  );
  let allocations: Array<{
    movementId: number;
    quantity: number;
    receiptUnitPrice: number;
  }> = [];
  if (costRows.length) {
    allocations = await db
      .select({
        movementId: movementBatchAllocationsTable.movementId,
        quantity: movementBatchAllocationsTable.quantity,
        receiptUnitPrice: movementsTable.unitPrice,
      })
      .from(movementBatchAllocationsTable)
      .innerJoin(
        movementsTable,
        eq(movementBatchAllocationsTable.receiptMovementId, movementsTable.id),
      )
      .where(
        inArray(
          movementBatchAllocationsTable.movementId,
          costRows.map((row) => row.id),
        ),
      );
  }
  const costByMovement = new Map<number, number>();
  for (const allocation of allocations) {
    costByMovement.set(
      allocation.movementId,
      (costByMovement.get(allocation.movementId) ?? 0) +
        allocation.quantity * allocation.receiptUnitPrice,
    );
  }

  const financials = calculateSalesFinancials(expenseRows, allocations);
  const byTypeMap = new Map<string, { quantity: number; value: number; operations: number }>();
  const topMap = new Map<
    number,
    {
      productName: string;
      category: string;
      quantity: number;
      value: number;
      soldQuantity: number;
      revenue: number;
    }
  >();
  const timelineMap = new Map<
    string,
    {
      quantity: number;
      value: number;
      soldQuantity: number;
      soldValue: number;
      receiptQuantity: number;
      receiptValue: number;
      writeoffQuantity: number;
      writeoffValue: number;
    }
  >();
  for (const row of activeRows) {
    const value = row.quantity * row.unitPrice;
    const grouped = byTypeMap.get(row.type) ?? { quantity: 0, value: 0, operations: 0 };
    grouped.quantity += row.quantity;
    grouped.value += value;
    grouped.operations += 1;
    byTypeMap.set(row.type, grouped);

    const top = topMap.get(row.productId) ?? {
      productName: row.productName,
      category: row.category,
      quantity: 0,
      value: 0,
      soldQuantity: 0,
      revenue: 0,
    };
    top.quantity += row.quantity;
    top.value += value;
    // «Топ товаров» — про продажи: складывать проданное с принятым нельзя,
    // иначе первое место занимает товар, который просто много раз завозили.
    if (row.type === "expense") {
      top.soldQuantity += row.quantity;
      top.revenue += row.quantity * (row.saleUnitPrice ?? 0);
    }
    topMap.set(row.productId, top);

    const date = localDayKey(row.createdAt);
    const point = timelineMap.get(date) ?? {
      quantity: 0,
      value: 0,
      soldQuantity: 0,
      soldValue: 0,
      receiptQuantity: 0,
      receiptValue: 0,
      writeoffQuantity: 0,
      writeoffValue: 0,
    };
    point.quantity += row.quantity;
    point.value += value;
    // Разбивка по видам операций: сумма «всего» смешивает приход с продажей,
    // поэтому по ней нельзя судить о деньгах.
    if (row.type === "expense") {
      point.soldQuantity += row.quantity;
      point.soldValue += row.quantity * (row.saleUnitPrice ?? 0);
    } else if (row.type === "receipt") {
      point.receiptQuantity += row.quantity;
      point.receiptValue += value;
    } else if (row.type === "writeoff") {
      point.writeoffQuantity += row.quantity;
      point.writeoffValue += costByMovement.get(row.id) ?? value;
    }
    timelineMap.set(date, point);
  }

  const emptyDay = {
    quantity: 0,
    value: 0,
    soldQuantity: 0,
    soldValue: 0,
    receiptQuantity: 0,
    receiptValue: 0,
    writeoffQuantity: 0,
    writeoffValue: 0,
  };
  // Пустые дни периода остаются в графике: иначе линия «схлопывает» разрыв и
  // две продажи через неделю выглядят как соседние.
  const timeline = from && to
    ? enumerateLocalDays(from, to).map((date) => ({
        date,
        ...(timelineMap.get(date) ?? emptyDay),
      }))
    : [...timelineMap]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, value]) => ({ date, ...value }));

  const round = (value: number) => Math.round(value * 100) / 100;

  /**
   * Разбор по выбранному виду операций: строка на категорию или на товар.
   *
   * Выручка и прибыль осмысленны только у продаж, себестоимость — ещё и у
   * списаний (товар ушёл, денег не пришло). Поэтому «пустые» числа отдаются как
   * null: интерфейс показывает прочерк, а не ноль, который читался бы как
   * «продали на ноль рублей».
   */
  const breakdownRows = (() => {
    if (!breakdown) return null;
    const wantsProduct = breakdown === "product";
    const groups = new Map<
      string,
      { revenue: number; cost: number; quantity: number; operations: number; value: number }
    >();
    for (const row of activeRows) {
      const name = wantsProduct ? row.productName : row.category || "Без категории";
      const group = groups.get(name) ?? { revenue: 0, cost: 0, quantity: 0, operations: 0, value: 0 };
      group.quantity += row.quantity;
      group.operations += 1;
      group.value += row.quantity * row.unitPrice;
      if (row.type === "expense") {
        group.revenue += row.quantity * (row.saleUnitPrice ?? 0);
        group.cost += costByMovement.get(row.id) ?? 0;
      } else if (row.type === "writeoff") {
        group.cost += costByMovement.get(row.id) ?? 0;
      }
      groups.set(name, group);
    }
    const isSale = type === "expense";
    const isLoss = type === "writeoff";
    return {
      dimension: breakdown,
      type: type ?? "all",
      rows: [...groups]
        .map(([name, group]) => ({
          name,
          quantity: round(group.quantity),
          operations: group.operations,
          value: round(group.value),
          revenue: isSale ? round(group.revenue) : null,
          cost: isSale || isLoss ? round(group.cost) : null,
          profit: isSale ? round(group.revenue - group.cost) : null,
        }))
        .sort((left, right) => (right.revenue ?? right.value) - (left.revenue ?? left.value)),
    };
  })();

  // Итоги прошлого периода: сравнение считается от тех же сумм, что и текущие.
  const previous = previousPeriod
    ? (() => {
        const previousExpenses = previousRows.filter((row) => row.type === "expense");
        const previousFinancials = calculateSalesFinancials(
          previousExpenses,
          previousAllocations,
        );
        return {
          from: previousPeriod.from,
          to: previousPeriod.to,
          totalOperations: previousRows.length,
          totalQuantity: round(previousRows.reduce((sum, row) => sum + row.quantity, 0)),
          totalRevenue: round(previousFinancials.revenue),
          totalCost: round(previousFinancials.cost),
          grossProfit: round(previousFinancials.grossProfit),
        };
      })()
    : null;

  res.json(
    GetMovementAnalyticsResponse.parse({
      totalOperations: activeRows.length,
      totalQuantity: round(activeRows.reduce((sum, row) => sum + row.quantity, 0)),
      totalValue: round(
        activeRows.reduce((sum, row) => sum + row.quantity * row.unitPrice, 0),
      ),
      totalRevenue: round(financials.revenue),
      totalCost: round(financials.cost),
      grossProfit: round(financials.grossProfit),
      previous,
      byType: [...byTypeMap].map(([movementType, value]) => ({
        type: movementType,
        quantity: round(value.quantity),
        value: round(value.value),
        operations: value.operations,
      })),
      topProducts: [...topMap]
        .map(([id, value]) => ({
          productId: id,
          ...value,
          quantity: round(value.quantity),
          soldQuantity: round(value.soldQuantity),
          revenue: round(value.revenue),
          value: round(value.value),
        }))
        // В топе — только то, что продавалось: у остальных продаж нет.
        .filter((item) => item.soldQuantity > 0)
        .sort((a, b) => b.soldQuantity - a.soldQuantity || b.revenue - a.revenue)
        .slice(0, 10),
      timeline: timeline.map((item) => ({
        date: item.date,
        quantity: round(item.quantity),
        value: round(item.value),
        // Разбивка по видам операций: интерфейс рисует по ней отдельные линии,
        // потому что «всего» смешивает приход с продажей.
        soldQuantity: round(item.soldQuantity),
        soldValue: round(item.soldValue),
        receiptQuantity: round(item.receiptQuantity),
        receiptValue: round(item.receiptValue),
        writeoffQuantity: round(item.writeoffQuantity),
        writeoffValue: round(item.writeoffValue),
      })),
      breakdown: breakdownRows,
    }),
  );
});

export default router;