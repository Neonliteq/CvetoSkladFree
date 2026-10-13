import { useEffect, useState } from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { ChevronRight, Edit2, PackageOpen } from "lucide-react"
import {
  getGetDashboardQueryKey,
  getListMovementsQueryKey,
  getListProductReceiptsQueryKey,
  getListProductsQueryKey,
  useListProductReceipts,
  useUpdateReceipt,
  type Movement,
  type Product,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { formatCurrency, formatDate } from "@/lib/utils"
import { CreateMovementDialog } from "./create-movement-dialog"

const receiptSchema = z.object({
  quantity: z.coerce.number().positive("Количество должно быть больше нуля"),
  unitPrice: z.coerce.number().min(0, "Цена не может быть отрицательной"),
  // Наценка задаётся для позиции целиком, поэтому её можно поправить и после
  // приёмки — когда стала известна цена поставщика.
  markupPercent: z.coerce
    .number()
    .min(0, "Наценка не может быть отрицательной")
    .max(1000, "Слишком большая наценка"),
  batchArrivalDate: z.string().min(1, "Укажите дату прихода"),
  expiresAt: z.string().optional(),
  reason: z.string().optional(),
})

const dateInputValue = (value: string | null | undefined) =>
  value ? String(value).slice(0, 10) : ""

function EditReceiptDialog({
  product,
  receipt,
  compact = false,
}: {
  product: Product
  receipt: Movement
  /** Icon-only trigger for a dense row; the labelled button stays for cards. */
  compact?: boolean
}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const usedQuantity = receipt.quantity - (receipt.remainingQuantity ?? 0)
  const form = useForm<z.infer<typeof receiptSchema>>({
    resolver: zodResolver(
      receiptSchema.refine((value) => value.quantity >= usedQuantity, {
        path: ["quantity"],
        message: `Уже израсходовано ${usedQuantity} ${product.unit}`,
      }),
    ),
    defaultValues: {
      quantity: receipt.quantity,
      unitPrice: receipt.unitPrice,
      markupPercent: receipt.markupPercent ?? product.markupPercent,
      batchArrivalDate: dateInputValue(receipt.batchArrivalDate || receipt.createdAt),
      expiresAt: dateInputValue(receipt.expiresAt),
      reason: receipt.reason || "",
    },
  })

  useEffect(() => {
    if (!open) return
    form.reset({
      quantity: receipt.quantity,
      unitPrice: receipt.unitPrice,
      markupPercent: receipt.markupPercent ?? product.markupPercent,
      batchArrivalDate: dateInputValue(receipt.batchArrivalDate || receipt.createdAt),
      expiresAt: dateInputValue(receipt.expiresAt),
      reason: receipt.reason || "",
    })
  }, [form, open, receipt, product.markupPercent])

  const { mutate: updateReceipt, isPending } = useUpdateReceipt({
    mutation: {
      onSuccess: (updated) => {
        // Показываем, что стало с приходом: количество, закупка и остаток партии.
        const movement = updated ?? receipt
        toast.success("Приход обновлён", {
          description: [
            `${movement.productName}: ${movement.quantity} ${movement.unit || product.unit}`,
            `закупка ${formatCurrency(movement.unitPrice)}`,
            movement.remainingQuantity !== null && movement.remainingQuantity !== undefined
              ? `остаток партии ${movement.remainingQuantity} ${movement.unit || product.unit}`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          duration: 6000,
        })
        queryClient.invalidateQueries({
          queryKey: getListProductReceiptsQueryKey(product.id),
        })
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListMovementsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
        setOpen(false)
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось обновить приход")
      },
    },
  })

  const submit = (values: z.infer<typeof receiptSchema>) => {
    updateReceipt({
      id: receipt.id,
      data: {
        quantity: values.quantity,
        unitPrice: values.unitPrice,
        markupPercent: values.markupPercent,
        batchArrivalDate: values.batchArrivalDate,
        expiresAt: values.expiresAt || null,
        reason: values.reason || "",
      },
    })
  }

  return (
    <>
      {compact ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-11 w-11 md:h-9 md:w-9"
          aria-label={`Редактировать приход от ${formatDate(
            receipt.batchArrivalDate || receipt.createdAt,
          )}`}
          onClick={() => setOpen(true)}
        >
          <Edit2 className="h-4 w-4 text-muted-foreground" />
        </Button>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          <Edit2 className="mr-2 h-4 w-4" />
          Редактировать
        </Button>
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[560px]">
          <DialogHeader>
            <DialogTitle>Редактирование прихода</DialogTitle>
          </DialogHeader>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(submit)} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="quantity"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Количество, {product.unit}</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="unitPrice"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Закупочная цена</FormLabel>
                      <FormControl>
                        <Input type="number" step="0.01" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="markupPercent"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Наценка, %</FormLabel>
                      <FormControl>
                        <Input type="number" step="1" min="0" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="batchArrivalDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Дата прихода</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="expiresAt"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Свежесть до</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Комментарий</FormLabel>
                    <FormControl>
                      <Input placeholder="Поставщик или примечание" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {usedQuantity > 0 && (
                <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                  Из этой партии уже израсходовано {usedQuantity} {product.unit}.
                  Общее количество нельзя установить ниже этого значения.
                </p>
              )}
              <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
                Наценка задаётся для товара целиком и сразу пересчитывает цену продажи
                от средней закупочной цены. Сейчас в каталоге: наценка{" "}
                {product.markupPercent}%, цена {formatCurrency(product.salePrice)}.
              </p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                  Отмена
                </Button>
                <Button type="submit" disabled={isPending}>
                  {isPending ? "Сохранение..." : "Сохранить"}
                </Button>
              </div>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  )
}

const RECEIPTS_VIEW_KEY = "florasklad:receipts-view"

/** One batch per line, or a collapsed line that opens on tap. */
type ReceiptsView = "rows" | "expanded"

function readStoredView(): ReceiptsView {
  try {
    return window.localStorage.getItem(RECEIPTS_VIEW_KEY) === "expanded" ? "expanded" : "rows"
  } catch {
    // Storage can be unavailable (private mode); the default still works.
    return "rows"
  }
}

const isExpired = (receipt: Movement) =>
  receipt.expiresAt ? new Date(`${receipt.expiresAt}T23:59:59`) < new Date() : false

const remainingOf = (receipt: Movement) => receipt.remainingQuantity ?? receipt.quantity

const arrivalOf = (receipt: Movement) =>
  formatDate(receipt.batchArrivalDate || receipt.createdAt)

/**
 * Switches between the two density modes.
 *
 * Four receipts used to fill ~400 px of cards; the shop floor compares batches
 * by date, remainder and purchase price, so the toggle lives in the panel head
 * and the choice is remembered per device.
 */
function ReceiptsViewSwitch({
  view,
  onChange,
  count,
  product,
}: {
  view: ReceiptsView
  onChange: (view: ReceiptsView) => void
  count: number
  product: Product
}) {
  const options: Array<{ value: ReceiptsView; label: string; aria: string }> = [
    { value: "rows", label: "Строки", aria: "Показать приходы строками" },
    { value: "expanded", label: "Раскрытие", aria: "Показать приходы с раскрытием" },
  ]

  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex items-center gap-2">
        {/* «Провести» слева: кнопка перенесена из строки товара, а на панели
            ей место рядом с названием, а не в правом краю через весь экран. */}
        <div onClick={(event) => event.stopPropagation()}>
          <CreateMovementDialog initialProductId={product.id} triggerLabel="Провести" compact />
        </div>
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Приходы · {count}
        </span>
      </div>
      <div className="flex items-center gap-1" role="group" aria-label="Вид списка приходов">
        {options.map((option) => (
          <Button
            key={option.value}
            type="button"
            variant={view === option.value ? "secondary" : "ghost"}
            size="sm"
            // 44 px on a phone, compact on the desktop table.
            className="h-11 px-3 md:h-9"
            aria-label={option.aria}
            aria-pressed={view === option.value}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </Button>
        ))}

      </div>
    </div>
  )
}

function FreshnessCell({
  receipt,
  withPrefix = true,
}: {
  receipt: Movement
  /** The prefix is dropped where the surrounding line already names the field. */
  withPrefix?: boolean
}) {
  if (!receipt.expiresAt) {
    return <span className="text-xs text-muted-foreground">—</span>
  }
  const expired = isExpired(receipt)
  return (
    <Badge variant={expired ? "destructive" : "outline"} className="font-normal">
      {expired
        ? "Срок истёк"
        : withPrefix
          ? `Свежесть до ${formatDate(receipt.expiresAt)}`
          : formatDate(receipt.expiresAt)}
    </Badge>
  )
}

/** Variant A: one 44 px line per receipt, headers printed once. */
function ReceiptsRows({ product, receipts }: { product: Product; receipts: Movement[] }) {
  return (
    <div className="overflow-hidden rounded-lg border bg-background">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="w-[76px] px-2 py-2 text-left font-medium">
              <span className="sr-only">Действия</span>
            </th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Дата</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Остаток</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Закупка</th>
            <th scope="col" className="px-3 py-2 text-left font-medium">Свежесть</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((receipt) => (
            <tr
              key={receipt.id}
              className="h-11 border-b transition-colors last:border-0 hover:bg-muted/30"
            >
              <td className="px-2 py-0 align-middle">
                <EditReceiptDialog product={product} receipt={receipt} compact />
              </td>
              <td className="whitespace-nowrap px-3 py-0 align-middle font-medium">
                {arrivalOf(receipt)}
              </td>
              <td className="whitespace-nowrap px-3 py-0 text-right align-middle">
                {remainingOf(receipt)} из {receipt.quantity}{" "}
                <span className="text-muted-foreground">{product.unit}</span>
              </td>
              <td className="whitespace-nowrap px-3 py-0 text-right align-middle">
                {formatCurrency(receipt.unitPrice)}
              </td>
              <td className="whitespace-nowrap px-3 py-0 align-middle">
                <FreshnessCell receipt={receipt} />
              </td>

            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** Variant B: a 40 px line that opens into the full batch details. */
function ReceiptsExpanded({
  product,
  receipts,
  expandedId,
  onToggle,
}: {
  product: Product
  receipts: Movement[]
  expandedId: number | null
  onToggle: (id: number) => void
}) {
  return (
    <div className="divide-y overflow-hidden rounded-lg border bg-background">
      {receipts.map((receipt) => {
        const isOpen = expandedId === receipt.id
        return (
          <div key={receipt.id}>
            <button
              type="button"
              className="flex min-h-11 w-full items-center gap-3 px-3 text-left text-sm transition-colors hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-10"
              aria-expanded={isOpen}
              aria-label={`Приход от ${arrivalOf(receipt)}: ${isOpen ? "свернуть" : "раскрыть"}`}
              onClick={() => onToggle(receipt.id)}
            >
              <ChevronRight
                className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${
                  isOpen ? "rotate-90" : ""
                }`}
              />
              <span className="min-w-0 flex-1 truncate font-medium">{arrivalOf(receipt)}</span>
              <span className="shrink-0 whitespace-nowrap">
                {remainingOf(receipt)} из {receipt.quantity}
              </span>
              <span className="w-24 shrink-0 whitespace-nowrap text-right text-muted-foreground">
                {formatCurrency(receipt.unitPrice)}
              </span>
            </button>

            {isOpen && (
              <div className="space-y-2 border-t bg-muted/20 px-3 py-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-muted-foreground">Свежесть до:</span>
                  <FreshnessCell receipt={receipt} withPrefix={false} />
                </div>
                <p className="text-muted-foreground">
                  {receipt.reason || "Приход товара"}
                </p>
                <div className="pt-1">
                  <EditReceiptDialog product={product} receipt={receipt} />
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function ProductReceiptsPanel({ product }: { product: Product }) {
  const { data: receipts, isLoading, isError } = useListProductReceipts(product.id)
  const [view, setView] = useState<ReceiptsView>(readStoredView)
  const [expandedReceiptId, setExpandedReceiptId] = useState<number | null>(null)

  const chooseView = (next: ReceiptsView) => {
    setView(next)
    // The other mode has no open line, so a stale id would reopen something odd.
    setExpandedReceiptId(null)
    try {
      window.localStorage.setItem(RECEIPTS_VIEW_KEY, next)
    } catch {
      // The choice still holds for this session.
    }
  }

  if (isLoading) {
    return <p className="py-8 text-center text-sm text-muted-foreground">Загрузка приходов...</p>
  }
  if (isError) {
    return <p className="py-8 text-center text-sm text-destructive">Не удалось загрузить приходы.</p>
  }
  if (!receipts?.length) {
    return (
      <div className="flex flex-col items-center gap-3 py-8 text-muted-foreground">
        <PackageOpen className="h-6 w-6" />
        <p className="text-sm">Приходов по этому товару пока нет.</p>
        {/* Кнопка нужна и здесь: без строк её больше негде взять. */}
        <div onClick={(event) => event.stopPropagation()}>
          <CreateMovementDialog initialProductId={product.id} triggerLabel="Провести" compact />
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <ReceiptsViewSwitch
        view={view}
        onChange={chooseView}
        count={receipts.length}
        product={product}
      />
      {view === "rows" ? (
        <ReceiptsRows product={product} receipts={receipts} />
      ) : (
        <ReceiptsExpanded
          product={product}
          receipts={receipts}
          expandedId={expandedReceiptId}
          onToggle={(id) => setExpandedReceiptId((current) => (current === id ? null : id))}
        />
      )}
    </div>
  )
}