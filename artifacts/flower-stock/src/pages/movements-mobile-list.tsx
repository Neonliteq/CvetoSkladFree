import { Fragment, useState } from "react"
import type { Movement } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { ChevronDown } from "lucide-react"
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils"
import { getMovementTypeDetails, signedQuantity } from "@/lib/movement-types"
import { MovementDetails } from "./movement-details"
import { StatusBadge } from "@/components/status-badge"

/**
 * Mobile stand-in for the movements table: one card per operation, with the
 * signed quantity readable at a glance and the FIFO breakdown one tap away.
 */
export function MovementsMobileList({ movements }: { movements: Movement[] }) {
  const [expandedId, setExpandedId] = useState<number | null>(null)

  return (
    <div className="space-y-3">
      {movements.map((movement) => {
        const details = getMovementTypeDetails(movement.type)
        const Icon = details.icon
        const isExpanded = expandedId === movement.id

        return (
          <Fragment key={movement.id}>
            <div className="rounded-lg border bg-card p-3 shadow-sm">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span
                    className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium ${details.bg} ${details.color}`}
                  >
                    <Icon className="h-3 w-3" />
                    {details.label}
                  </span>
                  {/* Операция вне статистики: остаток изменился, отчёты её не
                      считают. Без метки это выглядело бы как потерянные данные. */}
                  {movement.excludeFromStats && (
                    <StatusBadge
                      tone="excluded"
                      className="ml-1.5"
                      title="Операция не учитывается в аналитике"
                    >
                      не в статистике
                    </StatusBadge>
                  )}
                  <div className="mt-1.5 font-medium leading-snug">{movement.productName}</div>
                </div>
                <div className="shrink-0 text-right">
                  <div className={`text-lg font-bold leading-none ${details.color}`}>
                    {signedQuantity(movement.type, movement.quantity)}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {formatDateTime(movement.createdAt)}
                  </div>
                </div>
              </div>

              <div className="mt-2 text-sm text-muted-foreground">
                {movement.reason || "—"}
                {movement.type === "expense" && movement.saleUnitPrice != null
                  ? ` · продано по ${formatCurrency(movement.saleUnitPrice)}`
                  : ""}
              </div>

              {/* Раскрыть можно любую операцию: автор, время с секундами и номер
                  накладной нужны и для простого прихода, где партий расхода нет. */}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-3 h-11 w-full justify-between"
                aria-expanded={isExpanded}
                aria-label={`Подробности операции: ${movement.productName}`}
                onClick={() => setExpandedId(isExpanded ? null : movement.id)}
              >
                <span>
                  {movement.batchAllocations.length > 0
                    ? `Партий: ${movement.batchAllocations.length}`
                    : "Подробнее"}
                </span>
                <ChevronDown
                  className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                />
              </Button>
            </div>

            {isExpanded && (
              <div className="rounded-lg border bg-muted/20 p-3">
                <MovementDetails movement={movement} />
              </div>
            )}
          </Fragment>
        )
      })}
    </div>
  )
}
