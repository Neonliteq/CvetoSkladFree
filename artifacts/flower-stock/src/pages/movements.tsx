import { Fragment, useMemo, useState } from "react"
import {
  Movement,
  getListMovementsQueryKey,
  getListProductsQueryKey,
  getGetDashboardQueryKey,
  useListMovements,
  useUndoMovement,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Undo2 } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { SearchInput } from "@/components/ui/search-input"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table"
import { formatCurrency, formatDate, formatDateTime } from "@/lib/utils"
import { getMovementTypeDetails } from "@/lib/movement-types"
import { CreateMovementDialog } from "./create-movement-dialog"
import { MovementsMobileList } from "./movements-mobile-list"
import { ChevronDown } from "lucide-react"
import { SortableTableHead } from "@/components/sortable-table-head"
import { ResizableTable } from "@/components/ui/resizable-table"

/**
 * Ширина истории операций на большом экране.
 *
 * Своя, отдельная от склада и букетов: в истории шесть колонок с длинными
 * комментариями, и общая ширина заставляла бы подгонять таблицы друг под друга.
 */
const TABLE_MIN_WIDTH = 760
const TABLE_DEFAULT_WIDTH = 1080
const TABLE_WIDTH_KEY = "florasklad:table-width:movements"

type MovementSortKey = "date" | "type" | "product" | "quantity" | "reason"

export default function MovementsPage() {
  // История листается порциями: раньше сервер отдавал только первые 30 записей,
  // и старые операции были недоступны вообще.
  const PAGE_SIZE = 50
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [search, setSearch] = useState("")
  const [typeFilter, setTypeFilter] = useState<string>("all")
  const [expandedMovementId, setExpandedMovementId] = useState<number | null>(null)
  const [sort, setSort] = useState<{ key: MovementSortKey; direction: "asc" | "desc" }>({
    key: "date",
    direction: "desc",
  })

  /**
   * Фильтры и сортировка уходят на сервер одним запросом.
   *
   * Поиск по названию товара и виду операции должен работать по всей истории, а
   * не только по загруженным строкам, а при листании порядок должен быть
   * сквозным — поэтому сортировка тоже серверная.
   */
  const { data: sortedMovements = [], isLoading } = useListMovements({
    limit: visibleCount,
    ...(typeFilter === "all" ? {} : { type: typeFilter as never }),
    ...(search.trim() ? { search: search.trim() } : {}),
    sort: sort.key,
    direction: sort.direction,
  })
  const loaded = sortedMovements.length
  // Если пришло меньше запрошенного, дальше записей нет.
  const hasMore = loaded >= visibleCount

  // Смена фильтра сужает выборку: прежнее число загруженных строк оставлять
  // нельзя, иначе счётчик и кнопка «показать ещё» врут.
  const resetPaging = () => setVisibleCount(PAGE_SIZE)

  const queryClient = useQueryClient()
  const { mutate: undoMovement, isPending: isUndoing } = useUndoMovement({
    mutation: {
      onSuccess: (result) => {
        toast.success(result.answer)
        queryClient.invalidateQueries({ queryKey: getListMovementsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
      },
      onError: (error: any) => {
        // Сервер объясняет причину: уже отменена, партия израсходована,
        // после операции были движения товара.
        toast.error(error?.data?.error || "Не удалось отменить операцию")
      },
    },
  })
  const toggleSort = (key: MovementSortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }))
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
            История операций
          </h1>
          <p className="text-muted-foreground mt-1">Все движения товаров по складу</p>
        </div>
        <CreateMovementDialog />
      </div>

      {/* Поиск по названию цветов и фильтр по виду операции. Оба уходят на
          сервер, поэтому находят операции по всей истории, а не только те,
          что уже загружены на страницу. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="w-full sm:max-w-sm">
          <SearchInput
            value={search}
            onChange={(next) => {
              setSearch(next)
              resetPaging()
            }}
            placeholder="Поиск по названию цветов..."
            label="Поиск операций по названию товара"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Вид операций">
          {[
            { value: "all", label: "Все" },
            { value: "receipt", label: "Приходы" },
            { value: "expense", label: "Продажи" },
            { value: "writeoff", label: "Списания" },
            { value: "production_input", label: "Сборка" },
          ].map((option) => (
            <Button
              key={option.value}
              type="button"
              variant={typeFilter === option.value ? "default" : "outline"}
              className="h-11 px-3 md:h-10"
              aria-pressed={typeFilter === option.value}
              aria-label={`Показать: ${option.label.toLowerCase()}`}
              onClick={() => {
                setTypeFilter(option.value)
                resetPaging()
              }}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground shadow-sm">
          Загрузка...
        </div>
      ) : loaded === 0 ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground shadow-sm">
          {search.trim() || typeFilter !== "all"
            ? "По этим условиям операций не найдено. Измените поиск или вид операции."
            : "История пуста."}
        </div>
      ) : (
        <>
          <div className="md:hidden">
            <MovementsMobileList movements={sortedMovements} />
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
              <SortableTableHead label="Дата и время" active={sort.key === "date"} direction={sort.direction} onClick={() => toggleSort("date")} />
              <SortableTableHead label="Тип" active={sort.key === "type"} direction={sort.direction} onClick={() => toggleSort("type")} />
              <SortableTableHead label="Товар" active={sort.key === "product"} direction={sort.direction} onClick={() => toggleSort("product")} />
              <SortableTableHead label="Количество" active={sort.key === "quantity"} direction={sort.direction} onClick={() => toggleSort("quantity")} className="text-right" />
              <SortableTableHead label="Комментарий" active={sort.key === "reason"} direction={sort.direction} onClick={() => toggleSort("reason")} />
              <TableHead className="w-[48px] text-right">
                <span className="sr-only">Отмена</span>
              </TableHead>
              {/* Полоса для растягивания: она должна попадать внутрь окна, иначе
                  её перекрывает соседний блок страницы. */}
              <TableHead className="w-[14px] p-0" aria-hidden />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedMovements.map((movement) => {
                const details = getMovementTypeDetails(movement.type)
                const Icon = details.icon
                
                return (
                  <Fragment key={movement.id}>
                  <TableRow>
                    <TableCell className="text-sm">
                      {formatDateTime(movement.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium ${details.bg} ${details.color}`}>
                        <Icon className="h-3 w-3" />
                        {details.label}
                      </div>
                    </TableCell>
                    <TableCell className="font-medium">
                      {movement.productName}
                    </TableCell>
                    <TableCell className={`text-right font-bold ${details.color}`}>
                      {['receipt', 'production_output'].includes(movement.type) ? '+' : '-'}{movement.quantity}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      <div className="flex items-center justify-between gap-3">
                        <span className="flex flex-wrap items-center gap-2">
                          {/* Операция вне статистики: остаток она изменила, а в
                              отчёты не попала. Без метки это выглядело бы как
                              потерянные данные. */}
                          {movement.excludeFromStats && (
                            <Badge
                              variant="outline"
                              className="border-amber-500/60 bg-amber-500/10 font-normal text-amber-700 dark:text-amber-400"
                              title="Операция не учитывается в аналитике"
                            >
                              не в статистике
                            </Badge>
                          )}
                          <span>
                            {movement.reason || '—'}
                            {movement.type === 'expense' && movement.saleUnitPrice != null
                              ? ` · Продано по ${formatCurrency(movement.saleUnitPrice)}`
                              : ''}
                          </span>
                        </span>
                        {movement.batchAllocations.length > 0 && (
                          <button
                            type="button"
                            onClick={() => setExpandedMovementId(
                              expandedMovementId === movement.id ? null : movement.id,
                            )}
                            className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
                          >
                            FIFO: {movement.batchAllocations.length} {movement.batchAllocations.length === 1 ? 'партия' : 'партии'}
                            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expandedMovementId === movement.id ? 'rotate-180' : ''}`} />
                          </button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      {/* Отменяем любой складской расход или приход. Сервер сам
                          откажет, если операция уже отменена, партия
                          израсходована или после неё были движения товара. */}
                      {!movement.reversalOfMovementId &&
                        ["receipt", "expense", "writeoff", "production_input"].includes(movement.type) && (
                          <AlertDialog>
                            <AlertDialogTrigger asChild>
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Отменить операцию: ${movement.productName}, ${movement.quantity}`}
                                title="Отменить операцию"
                              >
                                <Undo2 className="h-4 w-4 text-muted-foreground" />
                              </Button>
                            </AlertDialogTrigger>
                            {/* Отмена необратима: вернуть операцию можно только
                                новой записью, поэтому спрашиваем подтверждение. */}
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>Отменить операцию?</AlertDialogTitle>
                                <AlertDialogDescription>
                                  {details.label}: {movement.productName},{" "}
                                  {movement.quantity} {movement.reason ? `· ${movement.reason}` : ""}
                                  <br />
                                  Остатки партий восстановятся, а в истории появится компенсирующая запись.
                                  Повторить отменённую операцию автоматически нельзя — только провести заново.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>Оставить</AlertDialogCancel>
                                <AlertDialogAction
                                  disabled={isUndoing}
                                  onClick={() => undoMovement({ id: movement.id })}
                                >
                                  Отменить операцию
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        )}
                    </TableCell>
                  </TableRow>
                  {movement.batchAllocations.length > 0 && expandedMovementId === movement.id && (
                      <TableRow key={`${movement.id}-allocations`} className="bg-muted/30 hover:bg-muted/30">
                        <TableCell />
                        <TableCell colSpan={6} className="py-3">
                          <div className="rounded-lg border bg-background p-3">
                            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              Списано по FIFO
                            </p>
                            <div className="space-y-2">
                              {movement.batchAllocations.map((batch) => (
                                <div key={batch.receiptMovementId} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                                  <span>
                                    Поставка №{batch.receiptMovementId}
                                    {batch.batchArrivalDate ? ` от ${formatDate(batch.batchArrivalDate)}` : ''}
                                    {batch.supplier ? ` · ${batch.supplier}` : ''}
                                  </span>
                                  <span className="text-right">
                                    <span className="font-semibold">{batch.quantity}</span>
                                    <span className="ml-2 text-muted-foreground">
                                      × {formatCurrency(batch.unitPrice)}
                                    </span>
                                    <span className="ml-2 font-semibold">
                                      = {formatCurrency(batch.lineCost)}
                                    </span>
                                  </span>
                                </div>
                              ))}
                            </div>
                            <div className="mt-3 flex items-center justify-between border-t pt-3 text-sm font-semibold">
                              <span>Фактическая стоимость расхода</span>
                              <span>{formatCurrency(movement.totalCost)}</span>
                            </div>
                          </div>
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

          {/* Догрузка истории: без неё старые операции были недоступны. */}
          <div className="mt-3 flex flex-col items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {loaded < visibleCount
                ? `Показаны все операции: ${loaded}`
                : `Показано операций: ${loaded}`}
            </p>
            {hasMore && (
              <Button
                variant="outline"
                className="h-11 w-full md:h-10 md:w-auto"
                disabled={isLoading}
                onClick={() => setVisibleCount((current) => current + PAGE_SIZE)}
              >
                {isLoading ? "Загрузка..." : "Показать ещё 50"}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  )
}
