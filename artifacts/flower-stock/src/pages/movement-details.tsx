import type { Movement } from "@workspace/api-client-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { getMovementTypeDetails } from "@/lib/movement-types"
import { StatusNote } from "@/components/status-badge"

/**
 * Время операции с секундами.
 *
 * В строке списка время показано до минут — этого хватает, чтобы найти операцию. В деталях
 * нужны секунды: две продажи подряд в одну минуту иначе выглядят одинаково, и нельзя
 * понять, какая была раньше.
 */
function formatFullDateTime(value: string) {
  const date = new Date(value)
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date)
}

/** Строка «подпись — значение». Показывается только если значение есть. */
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <dt className="text-muted-foreground">{label}:</dt>
      <dd className="font-medium text-foreground">{children}</dd>
    </div>
  )
}

/**
 * Подробности операции: кто и когда оформил, чем именно она была.
 *
 * Одна на таблицу и на мобильный список — иначе два вида показывали бы разные подробности.
 * Показываются **только заполненные поля**: у продажи нет срока годности, у прихода — цены
 * продажи, и пустые строки «—» в деталях были бы шумом.
 *
 * Значения берутся из самой операции, а не досчитываются: это снимок на момент проведения
 * (наценка, закупочная цена, остаток партии), поэтому он не меняется задним числом.
 */
export function MovementDetails({ movement }: { movement: Movement }) {
  const details = getMovementTypeDetails(movement.type)
  const isReceipt = movement.type === "receipt"
  const allocations = movement.batchAllocations ?? []

  return (
    <div className="space-y-3" data-testid="movement-details">
      <dl className="grid gap-x-6 gap-y-1.5 text-sm sm:grid-cols-2">
        <DetailRow label="Оформил">
          {movement.createdByName ?? "не записан (операция до появления учёта авторов)"}
        </DetailRow>
        <DetailRow label="Время">{formatFullDateTime(String(movement.createdAt))}</DetailRow>
        <DetailRow label="Операция">
          {details.label} · {movement.quantity} {movement.unit}
        </DetailRow>
        <DetailRow label="Номер операции">№{movement.id}</DetailRow>

        {movement.orderNumber && (
          <DetailRow label="Накладная">{movement.orderNumber}</DetailRow>
        )}
        {movement.batchArrivalDate && (
          <DetailRow label="Дата прихода">{formatDate(movement.batchArrivalDate)}</DetailRow>
        )}
        {movement.cutDate && <DetailRow label="Дата срезки">{formatDate(movement.cutDate)}</DetailRow>}
        {movement.expiresAt && (
          <DetailRow label="Срок годности">{formatDate(movement.expiresAt)}</DetailRow>
        )}

        {/* Суммы и цены: у продажи важна цена продажи, у прихода — закупка и наценка. */}
        {movement.unitPrice > 0 && (
          <DetailRow label={isReceipt ? "Закупка за единицу" : "Себестоимость за единицу"}>
            {formatCurrency(movement.unitPrice)}
          </DetailRow>
        )}
        {movement.saleUnitPrice != null && (
          <DetailRow label="Цена продажи">{formatCurrency(movement.saleUnitPrice)}</DetailRow>
        )}
        {movement.totalCost > 0 && (
          <DetailRow label={isReceipt ? "Сумма закупки" : "Стоимость расхода"}>
            {formatCurrency(movement.totalCost)}
          </DetailRow>
        )}
        {(movement.markupPercent ?? 0) > 0 && (
          <DetailRow label="Наценка">{movement.markupPercent}%</DetailRow>
        )}
        {movement.previousMarkupPercent != null &&
          movement.previousMarkupPercent !== movement.markupPercent && (
            <DetailRow label="Наценка до операции">{movement.previousMarkupPercent}%</DetailRow>
          )}

        {/* Остаток партии — только у прихода: у расхода партии расходуются, и остаток
            самого прихода тут ни при чём. */}
        {isReceipt && movement.remainingQuantity != null && (
          <DetailRow label="Остаток в партии">
            {movement.remainingQuantity} из {movement.quantity} {movement.unit}
          </DetailRow>
        )}

        {movement.reversalOfMovementId != null && (
          <DetailRow label="Отмена">
            компенсирует операцию №{movement.reversalOfMovementId}
          </DetailRow>
        )}
        {movement.assistantBatchId && (
          <DetailRow label="Проведено">командой ассистента</DetailRow>
        )}
      </dl>

      {movement.excludeFromStats && (
        <StatusNote tone="excluded">
          Остаток операцией изменён, но в аналитике она не учитывается.
        </StatusNote>
      )}

      {movement.reason && (
        <p className="text-sm">
          <span className="text-muted-foreground">Комментарий: </span>
          {movement.reason}
        </p>
      )}

      {/* Из каких партий списано. Показываем только когда их больше одной или когда это
          не единственная допустимая: для одного расхода из одной партии хватает строк
          выше, а подробный разбор нужен, когда партий несколько. */}
      {allocations.length > 0 && (
        <div className="rounded-lg border bg-background p-3">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {allocations.length === 1 ? "Списано из партии" : "Списано из партий"}
          </p>
          <div className="space-y-1.5">
            {allocations.map((batch) => (
              <div
                key={batch.receiptMovementId}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  Поставка №{batch.receiptMovementId}
                  {batch.batchArrivalDate ? ` от ${formatDate(batch.batchArrivalDate)}` : ""}
                  {batch.supplier ? ` · ${batch.supplier}` : ""}
                </span>
                <span className="text-right">
                  <span className="font-semibold">{batch.quantity}</span>
                  <span className="ml-2 text-muted-foreground">
                    × {formatCurrency(batch.unitPrice)}
                  </span>
                  <span className="ml-2 font-semibold">= {formatCurrency(batch.lineCost)}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
