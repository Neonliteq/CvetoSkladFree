import { Fragment, useMemo, useState } from "react"
import { useGetDelivery, useListDeliveries } from "@workspace/api-client-react"
import type { Delivery } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { SearchInput } from "@/components/ui/search-input"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { ResizableTable } from "@/components/ui/resizable-table"
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils"
import { ChevronDown, Loader2, Truck } from "lucide-react"

const PAGE_SIZE = 50
const TABLE_WIDTH_KEY = "florasklad:deliveries-width"
const TABLE_MIN_WIDTH = 980
const TABLE_DEFAULT_WIDTH = 1040

/**
 * Поставки: кто и когда проводил приход.
 *
 * Поставка — это приход, проведённый в один момент одним человеком (позиции одной накладной
 * пишутся одной транзакцией). Экран отвечает на вопрос «пришло ли то, что мы заказывали, и
 * кто это принял»: дата прихода, номер, позиции, сумма, автор и время проведения.
 *
 * Состав запрашивается только для раскрытой поставки: список на сотню документов иначе
 * приносил бы тысячи строк.
 */
export default function DeliveriesPage() {
  const [search, setSearch] = useState("")
  const [from, setFrom] = useState("")
  const [to, setTo] = useState("")
  const [limit, setLimit] = useState(PAGE_SIZE)
  const [expanded, setExpanded] = useState<string | null>(null)

  const query = useMemo(
    () => ({
      limit,
      offset: 0,
      ...(search.trim() ? { search: search.trim() } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
    }),
    [limit, search, from, to],
  )

  const { data, isLoading } = useListDeliveries(query)
  const items = data?.items ?? []
  const total = data?.total ?? 0

  const totals = items.reduce(
    (acc, item) => ({
      quantity: acc.quantity + item.quantity,
      cost: acc.cost + item.cost,
    }),
    { quantity: 0, cost: 0 },
  )

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground md:text-3xl">Поставки</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Кто и когда проводил приход — по документам
        </p>
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 p-3 sm:p-4 lg:flex-row lg:items-end">
          <div className="min-w-0 flex-1">
            <Label htmlFor="delivery-search" className="mb-1 block text-xs text-muted-foreground">
              Поиск
            </Label>
            <SearchInput
              label="Поиск поставок"
              value={search}
              onChange={setSearch}
              placeholder="Номер накладной, товар или поставщик"
            />
          </div>
          <div className="flex gap-2">
            <div className="w-36">
              <Label htmlFor="delivery-from" className="mb-1 block text-xs text-muted-foreground">
                Дата прихода с
              </Label>
              <Input
                id="delivery-from"
                type="date"
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </div>
            <div className="w-36">
              <Label htmlFor="delivery-to" className="mb-1 block text-xs text-muted-foreground">
                по
              </Label>
              <Input
                id="delivery-to"
                type="date"
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
        <span>
          Поставок: <strong className="text-foreground">{total}</strong>
        </span>
        {items.length > 0 && (
          <>
            <span>
              Показано: <strong className="text-foreground">{items.length}</strong>
            </span>
            <span>
              Единиц: <strong className="text-foreground">{totals.quantity}</strong>
            </span>
            <span>
              Сумма закупки:{" "}
              <strong className="text-foreground">{formatCurrency(totals.cost)}</strong>
            </span>
          </>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center rounded-lg border bg-card py-12 text-sm text-muted-foreground">
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          Загружаем поставки...
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border bg-card py-12 text-center text-sm text-muted-foreground">
          {search.trim() || from || to
            ? "По этим условиям поставок не найдено."
            : "Поставок пока нет: они появятся после первого прихода."}
        </div>
      ) : (
        <>
          {/* Телефон: карточки, как в истории операций — таблица на 7 колонок не читается. */}
          <div className="space-y-3 md:hidden">
            {items.map((item) => (
              <DeliveryCard
                key={item.key}
                item={item}
                expanded={expanded === item.key}
                onToggle={() => setExpanded(expanded === item.key ? null : item.key)}
              />
            ))}
          </div>

          <div className="hidden md:block">
            <ResizableTable
              storageKey={TABLE_WIDTH_KEY}
              minWidth={TABLE_MIN_WIDTH}
              defaultWidth={TABLE_DEFAULT_WIDTH}
            >
              {(width) => (
              <Table className="w-auto" style={{ width: `${width}px`, minWidth: `${TABLE_MIN_WIDTH}px` }}>
                <TableHeader>
                  <TableRow className="bg-muted/50">
                    <TableHead className="w-[14px] p-0" aria-hidden />
                    <TableHead className="whitespace-nowrap">Дата прихода</TableHead>
                    <TableHead>Номер</TableHead>
                    <TableHead>Состав</TableHead>
                    <TableHead className="whitespace-nowrap text-right">Позиций</TableHead>
                    <TableHead className="whitespace-nowrap text-right">Единиц</TableHead>
                    <TableHead className="whitespace-nowrap text-right">Сумма</TableHead>
                    <TableHead className="whitespace-nowrap">Кто провёл</TableHead>
                    <TableHead className="whitespace-nowrap">Проведено</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((item) => {
                    const isOpen = expanded === item.key
                    return (
                      <Fragment key={item.key}>
                        <TableRow
                          className="cursor-pointer"
                          onClick={() => setExpanded(isOpen ? null : item.key)}
                        >
                          <TableCell className="p-0 pl-1">
                            <ChevronDown
                              className={`h-4 w-4 text-muted-foreground transition-transform ${isOpen ? "rotate-180" : ""}`}
                            />
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {item.arrivedAt ? formatDate(item.arrivedAt) : "—"}
                          </TableCell>
                          <TableCell className="font-medium">
                            {item.orderNumber || <span className="text-muted-foreground">без номера</span>}
                          </TableCell>
                          <TableCell className="max-w-[16rem] truncate text-muted-foreground">
                            {(item.products ?? []).join(", ")}
                            {item.positions > (item.products ?? []).length ? "…" : ""}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{item.positions}</TableCell>
                          <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                          <TableCell className="whitespace-nowrap text-right font-medium tabular-nums">
                            {formatCurrency(item.cost)}
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            {item.createdByName ?? (
                              <span className="text-muted-foreground">не записан</span>
                            )}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDateTime(item.deliveredAt)}
                          </TableCell>
                        </TableRow>
                        {isOpen && (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={8} className="py-3">
                              <DeliveryPositions itemKey={item.key} />
                            </TableCell>
                          </TableRow>
                        )}
                      </Fragment>
                    )
                  })}
                </TableBody>
              </Table>
              )}
            </ResizableTable>
          </div>

          {items.length < total && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                className="h-11 md:h-10"
                onClick={() => setLimit((current) => current + PAGE_SIZE)}
              >
                Показать ещё
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/** Позиции раскрытой поставки: подгружаются по требованию. */
function DeliveryPositions({ itemKey }: { itemKey: string }) {
  const { data, isLoading } = useGetDelivery(itemKey)
  if (isLoading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        Загружаем позиции...
      </p>
    )
  }
  const movements = data?.movements ?? []
  return (
    <div className="rounded-lg border bg-background">
      <div className="divide-y divide-border/60">
        {movements.map((movement) => (
          <div
            key={movement.id}
            className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm"
          >
            <span className="min-w-0 font-medium">{movement.productName}</span>
            <span className="flex flex-wrap items-center gap-x-4 gap-y-1 text-muted-foreground">
              <span className="tabular-nums">
                {movement.quantity} {movement.unit}
              </span>
              <span className="tabular-nums">× {formatCurrency(movement.unitPrice)}</span>
              <span className="tabular-nums font-medium text-foreground">
                {formatCurrency(movement.quantity * movement.unitPrice)}
              </span>
              <span className="tabular-nums">
                {movement.expiresAt ? `годен до ${formatDate(movement.expiresAt)}` : "без срока"}
              </span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Карточка поставки для телефона. */
function DeliveryCard({
  item,
  expanded,
  onToggle,
}: {
  item: Delivery
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-start justify-between gap-3 text-sm">
          <span className="min-w-0">
            {item.orderNumber || "Без номера"}
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              {item.arrivedAt ? formatDate(item.arrivedAt) : "дата не указана"} ·{" "}
              {item.positions} поз. · {item.quantity} ед.
            </span>
          </span>
          <span className="shrink-0 tabular-nums">{formatCurrency(item.cost)}</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <p className="text-xs text-muted-foreground">
          {item.createdByName ? `Провёл: ${item.createdByName}` : "Автор не записан"} ·{" "}
          {formatDateTime(item.deliveredAt)}
        </p>
        <Button variant="outline" className="h-11 w-full justify-between" onClick={onToggle} aria-expanded={expanded}>
          {expanded ? "Скрыть позиции" : "Показать позиции"}
          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </Button>
        {expanded && <DeliveryPositions itemKey={item.key} />}
      </CardContent>
    </Card>
  )
}
