import assert from "node:assert/strict";
import test from "node:test";
import { calculateSalesFinancials } from "./financial-analytics.ts";

test("uses the actual sale price and combines multiple FIFO batches", () => {
  const result = calculateSalesFinancials(
    [{ id: 10, quantity: 5, saleUnitPrice: 150 }],
    [
      { movementId: 10, quantity: 2, receiptUnitPrice: 80 },
      { movementId: 10, quantity: 3, receiptUnitPrice: 90 },
    ],
  );

  assert.deepEqual(result, {
    revenue: 750,
    cost: 430,
    grossProfit: 320,
  });
});

test("uses a produced bouquet batch as the FIFO cost source", () => {
  const result = calculateSalesFinancials(
    [{ id: 20, quantity: 2, saleUnitPrice: 900 }],
    [{ movementId: 20, quantity: 2, receiptUnitPrice: 575 }],
  );

  assert.deepEqual(result, {
    revenue: 1800,
    cost: 1150,
    grossProfit: 650,
  });
});