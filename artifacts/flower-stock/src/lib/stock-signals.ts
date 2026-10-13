import type { ExpiringBatch } from "@workspace/api-client-react"

/**
 * How soon a batch counts as "running out" on the stock screen.
 *
 * The dashboard endpoint already narrows its `expiring` list to three days, so
 * this is the same threshold applied once more on the client: a wider API window
 * would not silently start colouring rows.
 */
export const EXPIRING_SOON_DAYS = 3

export type ExpiringInfo = {
  daysLeft: number
  expiresAt: string
}

/**
 * Indexes the dashboard's expiring batches by product.
 *
 * One product can have several batches running out at the same time. The most
 * urgent one is kept, because that is the number the shop floor has to act on.
 */
export function buildExpiringIndex(batches: ExpiringBatch[] | undefined) {
  const index = new Map<number, ExpiringInfo>()
  for (const batch of batches ?? []) {
    if (batch.daysLeft > EXPIRING_SOON_DAYS) continue
    const known = index.get(batch.productId)
    if (!known || batch.daysLeft < known.daysLeft) {
      index.set(batch.productId, { daysLeft: batch.daysLeft, expiresAt: batch.expiresAt })
    }
  }
  return index
}

/** "истекает через 2 дн." reads faster on the floor than a bare date. */
export function expiringLabel(daysLeft: number) {
  if (daysLeft < 0) return "срок истёк"
  if (daysLeft === 0) return "истекает сегодня"
  return `истекает через ${daysLeft} дн.`
}

/**
 * The row rule for low stock.
 *
 * A zero minimum means "this position has no threshold", not "everything is
 * below it", so it must not light the row up.
 */
export function isLowStock(product: { currentStock: number; minimumStock: number }) {
  return product.minimumStock > 0 && product.currentStock <= product.minimumStock
}
