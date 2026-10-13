import { Fragment, useState } from "react"
import type { Product } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  AlertCircle,
  ArchiveRestore,
  ChevronDown,
  Clock,
  Edit2,
  PackagePlus,
  Trash2,
} from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { expiringLabel, isLowStock, type ExpiringInfo } from "@/lib/stock-signals"
import { CreateMovementDialog } from "./create-movement-dialog"
import { ProductReceiptsPanel } from "./product-receipts-dialog"

type Props = {
  products: Product[]
  /** Batches about to expire, keyed by product id — the same index the table uses. */
  expiringByProduct: Map<number, ExpiringInfo>
  isDeleting: boolean
  isRestoring: boolean
  onEdit: (product: Product) => void
  onDelete: (product: Product) => void
  onRestore: (product: Product) => void
}

/**
 * Mobile stand-in for the products table.
 *
 * The table needs ~1070 px and a phone gives ~360 px, so on a phone it could
 * only be read by scrolling sideways through nine columns. Every field the table
 * shows is kept, but stacked into a card where the numbers that matter on the
 * shop floor (stock, minimum, sale price) are visible without any scrolling.
 */
export function ProductsMobileList({
  products,
  expiringByProduct,
  isDeleting,
  isRestoring,
  onEdit,
  onDelete,
  onRestore,
}: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null)

  return (
    <div className="space-y-3">
      {products.map((product) => {
        // Archived goods are not in rotation: low-stock and expiry marks on
        // them would only draw attention to something nobody works with.
        const archived = Boolean(product.archivedAt)
        const isLow = !archived && isLowStock(product)
        const expiring = archived ? undefined : expiringByProduct.get(product.id)
        const isExpanded = expandedId === product.id

        return (
          <Fragment key={product.id}>
            <div
              className={`rounded-xl border bg-card p-3 shadow-sm ${
                isLow ? "border-l-4 border-l-amber-500 bg-amber-500/5" : ""
              }`}
            >
              <button
                type="button"
                className="flex min-h-11 w-full items-start justify-between gap-3 text-left"
                aria-expanded={isExpanded}
                onClick={() => setExpandedId(isExpanded ? null : product.id)}
              >
                <div className="min-w-0">
                  <div className="flex items-start gap-1.5">
                    <span className={`font-medium leading-snug ${archived ? "text-muted-foreground" : ""}`}>
                      {product.name}
                    </span>
                    {isLow && <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />}
                    {archived && (
                      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                        в архиве
                      </span>
                    )}
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                    <span>{product.category}</span>
                    {product.variety && <span>· {product.variety}</span>}
                    {product.color && (
                      <Badge variant="outline" className="bg-background font-normal">
                        {product.color}
                      </Badge>
                    )}
                  </div>
                </div>
                <ChevronDown
                  className={`mt-1 h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                    isExpanded ? "rotate-180" : ""
                  }`}
                />
              </button>

              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <div className={`text-xl font-bold leading-none ${isLow ? "text-destructive" : ""}`}>
                    {product.currentStock}{" "}
                    <span className="text-sm font-normal text-muted-foreground">{product.unit}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    минимум {product.minimumStock} {product.unit}
                  </div>
                  {expiring && (
                    <div
                      className="mt-1 inline-flex items-center gap-1 rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-medium text-red-600 dark:text-red-400"
                      title={`Партия истекает ${formatDate(expiring.expiresAt)}`}
                    >
                      <Clock className="h-3 w-3" />
                      {expiringLabel(expiring.daysLeft)}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="font-bold text-primary">{formatCurrency(product.salePrice)}</div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    закупка {formatCurrency(product.averagePrice || product.purchasePrice)} · наценка{" "}
                    {product.markupPercent}%
                  </div>
                </div>
              </div>

              <div className="mt-2 text-xs text-muted-foreground">
                {product.lastReceiptDate
                  ? `Приход: ${formatDate(product.lastReceiptDate)}`
                  : "Приходов не было"}
              </div>

              {/* Every control is at least 44 px tall — the list is meant to be
                  used one-handed, often with gloves. */}
              <div className="mt-3 flex items-center gap-2">
                <div className="flex-1">
                  <CreateMovementDialog
                    initialProductId={product.id}
                    triggerLabel="Приход / расход"
                    compact
                    fullWidth
                  />
                </div>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 shrink-0"
                  aria-label={`Редактировать ${product.name}`}
                  onClick={() => onEdit(product)}
                >
                  <Edit2 className="h-4 w-4 text-muted-foreground" />
                </Button>
                {/* В архиве вместо корзины — возврат в работу. */}
                {archived ? (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    aria-label={`Вернуть из архива ${product.name}`}
                    disabled={isRestoring}
                    onClick={() => onRestore(product)}
                  >
                    <ArchiveRestore className="h-4 w-4 text-primary" />
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-11 w-11 shrink-0"
                    aria-label={`Убрать в архив ${product.name}`}
                    disabled={isDeleting}
                    onClick={() => onDelete(product)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>
            </div>

            {isExpanded && (
              <div className="rounded-xl border bg-muted/20 p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  <PackagePlus className="h-3.5 w-3.5" />
                  Партии товара
                </div>
                <ProductReceiptsPanel product={product} />
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
