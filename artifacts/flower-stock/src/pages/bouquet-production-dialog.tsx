import { useMemo } from "react"
import {
  Bouquet,
  useListProductionBatches,
  getListProductionBatchesQueryKey,
} from "@workspace/api-client-react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { formatCurrency, formatDate } from "@/lib/utils"
import { History } from "lucide-react"

/**
 * История сборок букета.
 *
 * Рецепт — это шаблон, а здесь видно, что реально ушло со склада в каждой
 * сборке и за сколько букет продали: замены цветка и правки цены не теряются.
 */
export function BouquetProductionDialog({
  bouquet,
  open,
  onOpenChange,
}: {
  bouquet: Bouquet | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const bouquetId = bouquet?.id ?? 0
  // Params is memoized: React Query keys off the object, and a fresh one on every
  // render would refetch the history in a loop while the dialog is open.
  const params = useMemo(() => ({ bouquetId, limit: 20 }), [bouquetId])
  const { data: batches, isLoading } = useListProductionBatches(params, {
    query: {
      enabled: open && Boolean(bouquet),
      queryKey: getListProductionBatchesQueryKey(params),
    },
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[620px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Сборки: {bouquet?.name}</DialogTitle>
        </DialogHeader>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Загрузка...</div>
        ) : !batches?.length ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            Букет ещё ни разу не собирали.
          </div>
        ) : (
          <div className="space-y-3">
            {batches.map((batch) => {
              const revenue = batch.salePrice * batch.quantity
              const cost = batch.calculatedCost * batch.quantity
              const profit = revenue - cost
              return (
                <div key={batch.id} className="rounded-xl border bg-card p-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <History className="h-4 w-4 text-muted-foreground" />
                      {formatDate(batch.createdAt)}
                      <span className="text-muted-foreground">
                        · {batch.quantity} шт
                        {batch.createdByName ? ` · ${batch.createdByName}` : ""}
                      </span>
                    </div>
                    <div className="text-sm">
                      <span className="text-muted-foreground">продажа </span>
                      <span className="font-bold text-primary">{formatCurrency(batch.salePrice)}</span>
                      <span className="text-muted-foreground"> за шт</span>
                    </div>
                  </div>

                  <div className="mt-2 flex flex-wrap gap-1">
                    {batch.ingredients.map((ingredient, index) => (
                      <Badge key={index} variant="outline" className="bg-background font-normal">
                        {ingredient.productName} × {ingredient.quantity} {ingredient.unit}
                      </Badge>
                    ))}
                  </div>

                  <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                    <span>себестоимость {formatCurrency(batch.calculatedCost)} за шт</span>
                    <span>затраты {formatCurrency(cost)}</span>
                    <span className={profit < 0 ? "text-destructive" : ""}>
                      прибыль {formatCurrency(profit)}
                    </span>
                    {/* Остаток по сборке: из неё же продаётся букет на складе. */}
                    <span className={batch.remainingQuantity > 0 ? "text-foreground" : ""}>
                      на складе {batch.remainingQuantity} из {batch.quantity}
                    </span>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
