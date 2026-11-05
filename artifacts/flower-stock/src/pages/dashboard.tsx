import { useGetDashboard } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { formatCurrency, formatDateTime } from "@/lib/utils"
import { getMovementTypeDetails, signedQuantity } from "@/lib/movement-types"
import { Link } from "wouter"
import { BulkMovementDialog } from "@/pages/bulk-movement-dialog"
import { MetricCard } from "@/components/metric-card"
import { AlertCircle, CheckCircle2, Clock, Flower2, Package, TrendingDown, Wallet } from "lucide-react"

/**
 * Сводка отвечает на один вопрос: **что делать сегодня**.
 *
 * Поэтому сверху — проблемы (просрочка и дефицит) с количеством и действием, а не сводные
 * числа. Раньше первым шли четыре карточки «всего товаров / единиц / заканчиваются / сроки»,
 * и пустая карточка «Всё в порядке, дефицита нет» занимала пол-экрана, отодвигая то, что
 * действительно требует внимания.
 *
 * Порядок блоков намеренный: проблемы → состояние склада → последние операции.
 */

export default function DashboardPage() {
  const { data: dashboard, isLoading } = useGetDashboard()

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">Сводка</h1>
          <p className="mt-1 text-sm text-muted-foreground">Оценка состояния склада на сегодня</p>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
          {[...Array(4)].map((_, index) => (
            <Card key={index} className="animate-pulse">
              <CardContent className="h-20" />
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (!dashboard) return null

  // Просрочка и «истекает скоро» приходят одним списком: сервер отдаёт все партии со
  // сроком в пределах трёх дней, включая уже просроченные (у них `daysLeft` отрицательный).
  // Разделяем на клиенте, потому что смысл у них разный: просрочку списывают, истекающую —
  // продают быстрее.
  const expired = dashboard.expiring.filter((batch) => batch.daysLeft < 0)
  const soon = dashboard.expiring.filter((batch) => batch.daysLeft >= 0)
  const expiredQuantity = expired.reduce((sum, batch) => sum + batch.quantity, 0)
  const hasProblems = expired.length > 0 || dashboard.lowStock.length > 0

  // Один товар может лежать двумя партиями с разным сроком — для списания складываем
  // количество по товару, иначе в документе окажутся две строки одного товара.
  const expiredByProduct = [...expired.reduce((map, batch) => {
    const current = map.get(batch.productId) ?? { productId: batch.productId, quantity: 0 }
    current.quantity += batch.quantity
    map.set(batch.productId, current)
    return map
  }, new Map<number, { productId: number; quantity: number }>()).values()]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">Сводка</h1>
        <p className="mt-1 text-sm text-muted-foreground">Оценка состояния склада на сегодня</p>
      </div>

      {/* Главный блок: что требует внимания. Если проблем нет — одна спокойная строка
          вместо двух пустых карточек на пол-экрана. */}
      {hasProblems ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {expired.length > 0 && (
            <Card className="border-destructive/30">
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-destructive">
                  <AlertCircle className="h-4 w-4" />
                  Просрочено
                </CardTitle>
                <span className="text-xs text-muted-foreground">
                  {expired.length} {expired.length === 1 ? "партия" : "партии"} · {expiredQuantity} ед.
                </span>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="divide-y divide-border/60">
                  {expired.slice(0, 4).map((batch) => (
                    <div
                      key={`${batch.productId}-${batch.expiresAt}`}
                      className="flex items-center justify-between gap-3 py-2 first:pt-0"
                    >
                      <div className="min-w-0">
                        <Link
                          href={`/products?product=${batch.productId}`}
                          className="block truncate font-medium hover:text-primary hover:underline"
                          title="Открыть товар на складе"
                        >
                          {batch.productName}
                        </Link>
                        <p className="text-xs text-muted-foreground">{batch.quantity} ед. в партии</p>
                      </div>
                      <Badge variant="destructive" className="shrink-0 tabular-nums">
                        просрочено {Math.abs(batch.daysLeft)} дн.
                      </Badge>
                    </div>
                  ))}
                  {expired.length > 4 && (
                    <p className="pt-2 text-xs text-muted-foreground">
                      и ещё {expired.length - 4} — в истории операций
                    </p>
                  )}
                </div>
                <div className="flex justify-end">
                  <BulkMovementDialog
                    initialKind="writeoff"
                    initialPositions={expiredByProduct}
                    initialReason="Просроченный товар"
                    triggerLabel="Списать просроченное"
                    triggerVariant="destructive"
                    triggerClassName="h-11 md:h-9"
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {dashboard.lowStock.length > 0 && (
            <Card className="border-orange-500/30">
              <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0 pb-2">
                <CardTitle className="flex items-center gap-2 text-sm font-semibold text-orange-700 dark:text-orange-400">
                  <TrendingDown className="h-4 w-4" />
                  Заканчивается
                </CardTitle>
                <span className="text-xs text-muted-foreground">{dashboard.lowStockCount} поз.</span>
              </CardHeader>
              <CardContent>
                <div className="divide-y divide-border/60">
                  {dashboard.lowStock.slice(0, 4).map((item) => (
                    <div key={item.id} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                      <div className="min-w-0">
                        <Link
                          href={`/products?product=${item.id}`}
                          className="block truncate font-medium hover:text-primary hover:underline"
                          title="Открыть товар на складе"
                        >
                          {item.name}
                        </Link>
                        <p className="text-xs text-muted-foreground">
                          {item.variety || item.category}
                        </p>
                      </div>
                      <p className="shrink-0 text-right text-sm font-semibold tabular-nums text-orange-700 dark:text-orange-400">
                        {item.currentStock} {item.unit}
                        <span className="ml-1 text-xs font-normal text-muted-foreground">
                          из {item.minimumStock}
                        </span>
                      </p>
                    </div>
                  ))}
                  {dashboard.lowStock.length > 4 && (
                    <Link
                      href="/products?lowStock=1"
                      className="block pt-2 text-xs text-primary hover:underline"
                    >
                      и ещё {dashboard.lowStock.length - 4} — показать весь дефицит
                    </Link>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      ) : (
        <Card className="border-green-600/30 bg-green-600/5">
          <CardContent className="flex items-center gap-3 p-4">
            <CheckCircle2 className="h-5 w-5 shrink-0 text-green-700 dark:text-green-400" />
            <p className="text-sm">
              <span className="font-medium">Всё в порядке:</span> ни просроченных партий, ни
              позиций ниже минимума.
            </p>
          </CardContent>
        </Card>
      )}

      {/* Состояние склада: числа, по которым видно масштаб, но действовать по ним не нужно. */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        <MetricCard
          label="Товаров"
          value={dashboard.totalProducts.toLocaleString("ru-RU")}
          hint="Активных позиций"
          icon={Package}
        />
        <MetricCard
          label="Единиц на складе"
          value={dashboard.totalUnits.toLocaleString("ru-RU")}
          hint="Стеблей, штук, упаковок"
          icon={Flower2}
        />
        <MetricCard
          label="Стоимость склада"
          value={formatCurrency(dashboard.inventoryValue)}
          hint="По средней закупочной цене"
          icon={Wallet}
        />
        <MetricCard
          label="Истекает скоро"
          value={soon.length}
          hint={soon.length === 0 ? "В ближайшие три дня ничего" : "Партий в ближайшие три дня"}
          icon={Clock}
          tone={soon.length > 0 ? "warning" : "default"}
        />
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Последние операции</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="divide-y divide-border/60">
            {dashboard.recentMovements.map((movement) => {
              const details = getMovementTypeDetails(movement.type)
              return (
                <div key={movement.id} className="flex items-center justify-between gap-3 py-2 first:pt-0">
                  <div className="min-w-0">
                    <p className="truncate font-medium">{movement.productName}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatDateTime(movement.createdAt)} · {details.label}
                    </p>
                  </div>
                  <p className={`shrink-0 text-sm font-semibold tabular-nums ${details.color}`}>
                    {signedQuantity(movement.type, movement.quantity)}
                  </p>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
