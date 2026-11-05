import { useState } from "react"
import {
  getGetDashboardQueryKey,
  getListMovementsQueryKey,
  getListProductsQueryKey,
  useCreateBulkExpense,
  useCreateBulkReceipt,
  useCreateBulkWriteoff,
  useListProducts,
} from "@workspace/api-client-react"
import type { ApiError, BulkMovementResult } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ProductPicker } from "@/components/product-picker"
import { Layers, Loader2, Plus, Trash2 } from "lucide-react"
import { toast } from "sonner"

/** Вид массового документа. Один и тот же механизм, разные поля и разные маршруты. */
type BulkKind = "receipt" | "expense" | "writeoff"

/** Строка документа в том виде, в котором её заполняет кладовщик. */
type DraftRow = {
  /** Не индекс массива: строки удаляются, и ключ не должен «переезжать» на соседнюю. */
  key: number
  productId: string
  quantity: string
  /** Приход: закупочная цена за единицу. */
  unitPrice: string
  /** Приход: наценка позиции. */
  markupPercent: string
  /** Продажа: цена за единицу; подставляется из товара, но правится. */
  saleUnitPrice: string
  /** Списание: своя причина строки; пусто — берётся общая. */
  lineReason: string
}

let nextKey = 1
const emptyRow = (markupPercent = "100"): DraftRow => ({
  key: nextKey++,
  productId: "",
  quantity: "",
  unitPrice: "",
  markupPercent,
  saleUnitPrice: "",
  lineReason: "",
})

/** Сумма денег в формате магазина: без лишних нулей и с пробелом между разрядами. */
const money = (value: number) =>
  `${value.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽`

/**
 * Подписи и правила, которые различаются между видами.
 *
 * Собраны в одном месте, а не разбросаны по разметке: иначе пять мест пришлось бы править
 * при добавлении вида, и одно из них забылось бы.
 */
const KINDS: Record<
  BulkKind,
  {
    label: string
    hint: string
    commentLabel: string
    commentPlaceholder: string
    action: string
    success: string
    failure: string
    excludeHint: string
  }
> = {
  receipt: {
    label: "Приход",
    hint: "Одна накладная — несколько товаров. Проводится целиком: если в какой-то строке ошибка, не запишется ничего. Один и тот же товар можно указать дважды — это будут две партии со своей ценой.",
    commentLabel: "Комментарий",
    commentPlaceholder: "Например: Поставка Эквадор-Трейд",
    action: "Провести накладную",
    success: "Накладная проведена",
    failure: "Не удалось провести накладную",
    excludeHint: "вся накладная целиком",
  },
  expense: {
    label: "Продажа",
    hint: "Несколько продаж за один раз. Проводится целиком: если хотя бы одной позиции не хватает на складе, не продаётся ничего. Цена подставляется по наценке товара — её можно поправить в строке.",
    commentLabel: "Комментарий к продаже",
    commentPlaceholder: "Необязательно",
    action: "Провести продажу",
    success: "Продажа проведена",
    failure: "Не удалось провести продажу",
    excludeHint: "вся продажа целиком",
  },
  writeoff: {
    label: "Списание",
    hint: "Несколько списаний за один раз. Проводится целиком: если хотя бы одной позиции не хватает на складе, не списывается ничего. Причина — общая, но в строке можно указать свою.",
    commentLabel: "Причина списания",
    commentPlaceholder: "Например: Увядшие стебли",
    action: "Провести списание",
    success: "Списание проведено",
    failure: "Не удалось провести списание",
    excludeHint: "всё списание целиком",
  },
}

/**
 * Массовая операция: приход, продажа или списание по нескольким товарам сразу.
 *
 * Отдельное окно, а не режим одиночной операции: та форма используется ещё для правки и
 * для букетов, и второй сценарий в ней усложнил бы ежедневный путь ради редкого. Здесь
 * всё подчинено одному: заполнить список и провести его целиком.
 *
 * Сервер проводит документ в одной транзакции, поэтому ошибка в любой строке не записывает
 * ничего. Интерфейс показывает, какая именно строка неверна, — до отправки там, где это
 * видно без запроса.
 *
 * **Только складские товары.** Букет продаётся и списывается из конкретной сборки, а не
 * по FIFO: массовый документ такую сборку выбрать не может, и предлагать букеты значило бы
 * давать заполнить строку, которая гарантированно не проведётся.
 *
 * Окно принимает готовый набор строк и причину: кнопка «Списать просроченное» на сводке
 * открывает его уже заполненным. Заполнять, но не проводить — решение всё равно за
 * человеком: какие-то партии он захочет списать из-за брака, а не из-за срока.
 */
export function BulkMovementDialog({
  onDone,
  initialKind,
  initialPositions,
  initialReason,
  triggerLabel = "Массовая операция",
  triggerVariant = "outline",
  triggerClassName = "h-11 md:h-10",
}: {
  onDone?: () => void
  /** С какого вида открыть окно; по умолчанию — приход. */
  initialKind?: BulkKind
  /** Готовые строки: товар и количество. Остальное заполняется как обычно. */
  initialPositions?: Array<{ productId: number; quantity: number }>
  initialReason?: string
  triggerLabel?: string
  triggerVariant?: "outline" | "destructive" | "default"
  triggerClassName?: string
} = {}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const { data: products } = useListProducts()
  const [kind, setKind] = useState<BulkKind>(initialKind ?? "receipt")
  const [rows, setRows] = useState<DraftRow[]>(() =>
    initialPositions?.length
      ? initialPositions.map((position) => ({
          ...emptyRow(),
          productId: String(position.productId),
          quantity: String(position.quantity),
        }))
      : [emptyRow()],
  )
  const [orderNumber, setOrderNumber] = useState("")
  const [arrivalDate, setArrivalDate] = useState(new Date().toISOString().slice(0, 10))
  const [reason, setReason] = useState(initialReason ?? "")
  const [excludeFromStats, setExcludeFromStats] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const labels = KINDS[kind]

  const reset = () => {
    setRows([emptyRow()])
    setOrderNumber("")
    setArrivalDate(new Date().toISOString().slice(0, 10))
    setReason("")
    setExcludeFromStats(false)
    setError(null)
  }

  const onSuccess = (result: BulkMovementResult) => {
    // Сумма зависит от вида: у прихода это закупка, у продажи — выручка, у списания —
    // себестоимость списанного. Показывать везде одно и то же было бы враньём.
    const amount =
      kind === "expense"
        ? (result.totalRevenue ?? result.totalCost)
        : result.totalCost
    toast.success(KINDS[kind].success, {
      description: `${result.movements.length} поз. · ${result.totalQuantity} ед. · ${money(amount)}`,
      duration: 6000,
    })
    queryClient.invalidateQueries({ queryKey: getListMovementsQueryKey() })
    queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
    queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
    reset()
    setOpen(false)
    onDone?.()
  }

  const onError = (apiError: unknown) => {
    // Сервер называет проблемную строку: «Строка 3: Товар не найден». Показываем как есть —
    // по этому тексту сразу видно, что исправлять.
    const data = (apiError as ApiError | null)?.data
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error?: unknown }).error)
        : `Не удалось провести ${KINDS[kind].label.toLowerCase()}`
    setError(message)
    toast.error(KINDS[kind].failure, { description: message, duration: 8000 })
  }

  const receipt = useCreateBulkReceipt({ mutation: { onSuccess, onError } })
  const expense = useCreateBulkExpense({ mutation: { onSuccess, onError } })
  const writeoff = useCreateBulkWriteoff({ mutation: { onSuccess, onError } })

  const isPending = receipt.isPending || expense.isPending || writeoff.isPending

  const update = (key: number, patch: Partial<DraftRow>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  /** Подставляет цену продажи из товара: её видно и можно поправить по строке. */
  const pickProduct = (key: number, productId: number) => {
    const product = products?.find((item) => item.id === productId)
    update(key, {
      productId: String(productId),
      ...(kind === "expense" && product
        ? { saleUnitPrice: product.salePrice === 0 ? "" : String(product.salePrice) }
        : {}),
    })
  }

  const switchKind = (next: BulkKind) => {
    setKind(next)
    setError(null)
    if (next === "expense") {
      // Цены продажи подставляем при переключении: строки могли быть заполнены в режиме
      // прихода, где этого поля не было.
      setRows((current) =>
        current.map((row) => {
          if (!row.productId || row.saleUnitPrice !== "") return row
          const product = products?.find((item) => item.id === Number(row.productId))
          return product && product.salePrice > 0
            ? { ...row, saleUnitPrice: String(product.salePrice) }
            : row
        }),
      )
    }
  }

  const filled = rows.filter((row) => row.productId && Number(row.quantity) > 0)
  const totalQuantity = filled.reduce((sum, row) => sum + Number(row.quantity), 0)
  const totalPurchase = filled.reduce(
    (sum, row) => sum + Number(row.quantity) * (Number(row.unitPrice) || 0),
    0,
  )
  const totalRevenue = filled.reduce(
    (sum, row) => sum + Number(row.quantity) * (Number(row.saleUnitPrice) || 0),
    0,
  )

  const submit = () => {
    setError(null)
    // Сначала ищем конкретные ошибки в строках и называем номер: «Добавьте хотя бы один
    // товар» на строку с выбранным товаром и пустым количеством не объясняет, что править.
    const incomplete = rows.findIndex((row) => row.productId && !(Number(row.quantity) > 0))
    if (incomplete !== -1) {
      setError(`Строка ${incomplete + 1}: укажите количество`)
      return
    }
    const missingProduct = rows.findIndex((row) => !row.productId && Number(row.quantity) > 0)
    if (missingProduct !== -1) {
      setError(`Строка ${missingProduct + 1}: выберите товар`)
      return
    }
    if (filled.length === 0) {
      setError("Добавьте хотя бы один товар с количеством")
      return
    }

    if (kind === "receipt") {
      receipt.mutate({
        data: {
          positions: filled.map((row) => ({
            productId: Number(row.productId),
            quantity: Number(row.quantity),
            unitPrice: row.unitPrice === "" ? undefined : Number(row.unitPrice),
            markupPercent: row.markupPercent === "" ? undefined : Number(row.markupPercent),
          })),
          orderNumber: orderNumber.trim() ? orderNumber.trim() : null,
          // Строка даты, а не Date: сервер приводит её сам, как и в одиночном приходе.
          batchArrivalDate: arrivalDate ? arrivalDate : null,
          reason: reason.trim() ? reason.trim() : null,
          excludeFromStats,
        },
      })
      return
    }

    if (kind === "expense") {
      expense.mutate({
        data: {
          positions: filled.map((row) => ({
            productId: Number(row.productId),
            quantity: Number(row.quantity),
            // Пусто — сервер возьмёт цену товара по наценке.
            saleUnitPrice: row.saleUnitPrice === "" ? undefined : Number(row.saleUnitPrice),
          })),
          reason: reason.trim() ? reason.trim() : null,
          excludeFromStats,
        },
      })
      return
    }

    writeoff.mutate({
      data: {
        positions: filled.map((row) => ({
          productId: Number(row.productId),
          quantity: Number(row.quantity),
          reason: row.lineReason.trim() ? row.lineReason.trim() : null,
        })),
        reason: reason.trim() ? reason.trim() : null,
        excludeFromStats,
      },
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setError(null)
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={triggerVariant}
          className={triggerClassName}
          aria-label={triggerLabel}
        >
          <Layers className="mr-2 h-4 w-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Массовая операция</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Вид выбирается кнопками, а не списком: видов три, и выбор виден сразу — тот же
              приём, что в одиночной операции. */}
          <div className="flex flex-wrap gap-1" role="group" aria-label="Вид массовой операции">
            {(Object.keys(KINDS) as BulkKind[]).map((option) => (
              <Button
                key={option}
                type="button"
                variant={kind === option ? "default" : "outline"}
                className="h-11 px-4 md:h-10"
                aria-pressed={kind === option}
                data-testid={`bulk-kind-${option}`}
                onClick={() => switchKind(option)}
                disabled={isPending}
              >
                {KINDS[option].label}
              </Button>
            ))}
          </div>

          <p className="text-sm text-muted-foreground">{labels.hint}</p>

          <div className="space-y-3">
            {rows.map((row, index) => (
              <div
                key={row.key}
                className="rounded-lg border p-3"
                data-testid="bulk-movement-row"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    Строка {index + 1}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    className="h-9 px-2 text-muted-foreground"
                    aria-label={`Удалить строку ${index + 1}`}
                    onClick={() =>
                      setRows((current) =>
                        current.length === 1
                          ? current
                          : current.filter((item) => item.key !== row.key),
                      )
                    }
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>

                <div className="space-y-2">
                  <div className="space-y-1">
                    <Label htmlFor={`bulk-product-${row.key}`}>Товар</Label>
                    {/* Тот же выбор с поиском, что и в одиночной операции: позиций
                        несколько, и листать длинный список особенно утомительно. */}
                    <ProductPicker
                      id={`bulk-product-${row.key}`}
                      products={products}
                      value={row.productId ? Number(row.productId) : null}
                      onlyStock
                      ariaLabel={`Товар в строке ${index + 1}`}
                      onChange={(productId) => pickProduct(row.key, productId)}
                    />
                  </div>

                  <div
                    className={`grid gap-2 ${
                      kind === "receipt" ? "grid-cols-3" : "grid-cols-2"
                    }`}
                  >
                    <div className="space-y-1">
                      <Label htmlFor={`bulk-quantity-${row.key}`}>Количество</Label>
                      <Input
                        id={`bulk-quantity-${row.key}`}
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        value={row.quantity}
                        onChange={(event) => update(row.key, { quantity: event.target.value })}
                        placeholder="0"
                      />
                    </div>

                    {kind === "receipt" && (
                      <>
                        <div className="space-y-1">
                          <Label htmlFor={`bulk-price-${row.key}`}>Закупка</Label>
                          <Input
                            id={`bulk-price-${row.key}`}
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            value={row.unitPrice}
                            onChange={(event) =>
                              update(row.key, { unitPrice: event.target.value })
                            }
                            placeholder="цена"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor={`bulk-markup-${row.key}`}>Наценка %</Label>
                          <Input
                            id={`bulk-markup-${row.key}`}
                            type="number"
                            step="0.1"
                            inputMode="decimal"
                            value={row.markupPercent}
                            onChange={(event) =>
                              update(row.key, { markupPercent: event.target.value })
                            }
                          />
                        </div>
                      </>
                    )}

                    {kind === "expense" && (
                      <div className="space-y-1">
                        <Label htmlFor={`bulk-sale-price-${row.key}`}>Цена продажи</Label>
                        <Input
                          id={`bulk-sale-price-${row.key}`}
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={row.saleUnitPrice}
                          onChange={(event) =>
                            update(row.key, { saleUnitPrice: event.target.value })
                          }
                          placeholder="по наценке"
                        />
                      </div>
                    )}

                    {kind === "writeoff" && (
                      <div className="space-y-1">
                        <Label htmlFor={`bulk-line-reason-${row.key}`}>Своя причина</Label>
                        <Input
                          id={`bulk-line-reason-${row.key}`}
                          value={row.lineReason}
                          onChange={(event) =>
                            update(row.key, { lineReason: event.target.value })
                          }
                          placeholder="как общая"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            className="h-11 w-full md:h-10"
            onClick={() =>
              // Наценку берём из последней строки: в одной накладной она обычно одинаковая.
              setRows((current) => [...current, emptyRow(current.at(-1)?.markupPercent ?? "100")])
            }
            disabled={rows.length >= 50}
          >
            <Plus className="mr-2 h-4 w-4" />
            Добавить строку
          </Button>

          {kind === "receipt" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="bulk-order">Номер накладной</Label>
                <Input
                  id="bulk-order"
                  value={orderNumber}
                  onChange={(event) => setOrderNumber(event.target.value)}
                  placeholder="Необязательно"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="bulk-date">Дата прихода</Label>
                <Input
                  id="bulk-date"
                  type="date"
                  value={arrivalDate}
                  onChange={(event) => setArrivalDate(event.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label htmlFor="bulk-reason">{labels.commentLabel}</Label>
            <Input
              id="bulk-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder={labels.commentPlaceholder}
            />
          </div>

          <div className="flex flex-row items-start gap-3 rounded-lg border p-3">
            <Checkbox
              checked={excludeFromStats}
              onCheckedChange={(checked) => setExcludeFromStats(checked === true)}
              aria-label="Не учитывать операцию в статистике"
              className="mt-0.5 h-6 w-6"
            />
            <div className="space-y-1 leading-none">
              <Label className="cursor-pointer">Не учитывать в статистике</Label>
              <p className="text-xs text-muted-foreground">
                Остатки изменятся, операции останутся в истории, но в выручку и графики не
                попадут — {labels.excludeHint}.
              </p>
            </div>
          </div>

          {/* Итог виден до отправки: по нему сверяют документ с бумагой. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-muted/40 p-3 text-sm">
            <span>
              Позиций: <strong>{filled.length}</strong>
            </span>
            <span>
              Всего: <strong>{totalQuantity}</strong>
            </span>
            {kind === "receipt" && (
              <span>
                Сумма закупки: <strong>{money(totalPurchase)}</strong>
              </span>
            )}
            {kind === "expense" && (
              <span>
                Выручка: <strong>{money(totalRevenue)}</strong>
              </span>
            )}
            {kind === "writeoff" && (
              // Себестоимость списания зависит от партий, из которых спишется, и до
              // проведения неизвестна. Обещать сумму, которой мы не знаем, нельзя.
              <span className="text-muted-foreground">
                Стоимость списания посчитается по партиям и появится в итоге.
              </span>
            )}
          </div>

          {error && (
            <div
              className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
              role="alert"
            >
              {error}
            </div>
          )}

          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="h-11 md:h-10"
              onClick={() => {
                reset()
                setOpen(false)
              }}
              disabled={isPending}
            >
              Отмена
            </Button>
            <Button className="h-11 md:h-10" onClick={submit} disabled={isPending}>
              {isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {labels.action}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}