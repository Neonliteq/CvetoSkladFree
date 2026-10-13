import type { Bouquet } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Edit2, History, PackagePlus } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"

type Props = {
  bouquets: Bouquet[]
  onProduce: (bouquet: Bouquet) => void
  onEdit: (bouquet: Bouquet) => void
  onHistory: (bouquet: Bouquet) => void
}

/**
 * Mobile stand-in for the bouquets table. The recipe is the important part on a
 * phone: it tells the shop what to pick before assembling, so the composition is
 * shown in full instead of being truncated into table cells.
 */
export function BouquetsMobileList({ bouquets, onProduce, onEdit, onHistory }: Props) {
  return (
    <div className="space-y-3">
      {bouquets.map((bouquet) => (
        <div key={bouquet.id} className="rounded-xl border bg-card p-3 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <span className="font-medium leading-snug">{bouquet.name}</span>
            <div className="shrink-0 text-right">
              <div className="text-xl font-bold leading-none">{bouquet.currentStock}</div>
              <div className="mt-1 text-xs text-muted-foreground">шт на складе</div>
            </div>
          </div>

          <div className="mt-2 flex flex-wrap gap-1">
            {bouquet.category && (
              <Badge variant="outline" className="bg-background font-normal">
                {bouquet.category}
              </Badge>
            )}
            {bouquet.components.length === 0 ? (
              <span className="text-xs text-muted-foreground">Нет состава</span>
            ) : (
              bouquet.components.map((component, index) => (
                <Badge key={index} variant="outline" className="bg-background font-normal">
                  {component.productName} × {component.quantity} {component.unit}
                </Badge>
              ))
            )}
          </div>

          <div className="mt-3 flex items-end justify-between gap-3 text-sm">
            <div>
              <div className="font-bold text-primary">{formatCurrency(bouquet.salePrice)}</div>
              <div className="mt-1 text-xs text-muted-foreground">
                себестоимость {formatCurrency(bouquet.calculatedCost)} · наценка{" "}
                {bouquet.markupPercent}%
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {bouquet.lastProduction
                  ? `Собирали ${formatDate(bouquet.lastProduction.createdAt)} по ${formatCurrency(bouquet.lastProduction.salePrice)}`
                  : "Ещё не собирали"}
              </div>
            </div>
          </div>

          <div className="mt-3 flex items-center gap-2">
            <Button
              variant="outline"
              className="h-11 flex-1"
              onClick={() => onProduce(bouquet)}
            >
              <PackagePlus className="mr-2 h-4 w-4 text-secondary" />
              Собрать рецепт
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 shrink-0"
              aria-label={`История сборок ${bouquet.name}`}
              onClick={() => onHistory(bouquet)}
            >
              <History className="h-4 w-4 text-muted-foreground" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-11 w-11 shrink-0"
              aria-label={`Редактировать ${bouquet.name}`}
              onClick={() => onEdit(bouquet)}
            >
              <Edit2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}
