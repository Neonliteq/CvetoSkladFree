export type FinancialSale = {
  id: number;
  quantity: number;
  saleUnitPrice: number | null;
};

export type CostAllocation = {
  movementId: number;
  quantity: number;
  receiptUnitPrice: number;
};

export function calculateSalesFinancials(
  sales: FinancialSale[],
  allocations: CostAllocation[],
) {
  const costByMovement = new Map<number, number>();
  for (const allocation of allocations) {
    costByMovement.set(
      allocation.movementId,
      (costByMovement.get(allocation.movementId) ?? 0) +
        allocation.quantity * allocation.receiptUnitPrice,
    );
  }

  const revenue = sales.reduce(
    (sum, sale) => sum + sale.quantity * (sale.saleUnitPrice ?? 0),
    0,
  );
  const cost = sales.reduce(
    (sum, sale) => sum + (costByMovement.get(sale.id) ?? 0),
    0,
  );

  return { revenue, cost, grossProfit: revenue - cost };
}