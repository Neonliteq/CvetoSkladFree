import { useMemo, useState } from "react"
import type { InvoiceDraftItem, InvoiceRecognition, Product } from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { AlertTriangle, Check, Loader2, PackagePlus, Sparkles } from "lucide-react"
import {
  CreateProductFromInvoiceDialog,
  type NewProductDraft,
} from "./create-product-from-invoice-dialog"

type LineState = {
  productId: number | null
  /** Set when the user decided to add a missing product from this line. */
  newProduct: NewProductDraft | null
  quantity: number
  unitPrice: number
}

export type InvoiceLineSubmission = {
  productId: number | null
  rawName: string
  quantity: number
  unitPrice: number
  newProduct?: NewProductDraft
}

const money = (value: number) =>
  new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 }).format(value)

/** The API returns a full timestamp for the document date; only the day matters. */
const shortDate = (value: string | null | undefined) => {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(value)
  return match ? `${match[3]}.${match[2]}.${match[1]}` : value
}

/**
 * Review card for a recognised delivery note.
 *
 * Nothing is posted from this component on its own: the user confirms the
 * lines, and only the lines that resolved to a catalog product are submitted.
 * Unresolved lines stay visible so they can be fixed later instead of being
 * silently dropped.
 */
export function InvoiceDraftCard({
  draft,
  products,
  status,
  appliedCount,
  isApplying,
  onApply,
}: {
  draft: InvoiceRecognition
  products: Product[]
  status: "pending" | "applied"
  appliedCount?: number | null
  isApplying: boolean
  onApply: (lines: InvoiceLineSubmission[]) => void
}) {
  const editable = status === "pending"
  const [lines, setLines] = useState<Record<number, LineState>>(() =>
    Object.fromEntries(
      draft.items.map((item, index) => [
        index,
        {
          productId: item.productId ?? null,
          newProduct: null,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        },
      ]),
    ),
  )
  const [creatingFor, setCreatingFor] = useState<number | null>(null)

  const total = useMemo(
    () =>
      Object.values(lines).reduce(
        (sum, line) => sum + (line.quantity || 0) * (line.unitPrice || 0),
        0,
      ),
    [lines],
  )

  const readyLines = draft.items
    .map((item, index) => ({ item, index, state: lines[index] }))
    .filter(({ state }) => state?.productId != null || state?.newProduct != null)

  const unresolved = draft.items.length - readyLines.length

  const update = (index: number, patch: Partial<LineState>) =>
    setLines((current) => ({
      ...current,
      [index]: {
        ...(current[index] ?? {
          productId: null,
          newProduct: null,
          quantity: 0,
          unitPrice: 0,
        }),
        ...patch,
      },
    }))

  const submit = () => {
    onApply(
      readyLines.map(({ item, index, state }) => ({
        productId: state.productId,
        rawName: item.rawName,
        quantity: lines[index].quantity,
        unitPrice: lines[index].unitPrice,
        ...(state.newProduct ? { newProduct: state.newProduct } : {}),
      })),
    )
  }

  return (
    <div className="w-full rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-primary" />
          <span className="font-medium">Накладная распознана</span>
          {draft.invoiceNumber && (
            <Badge variant="outline" className="font-normal">№ {draft.invoiceNumber}</Badge>
          )}
          {draft.invoiceDate && (
            <Badge variant="outline" className="font-normal">{shortDate(draft.invoiceDate)}</Badge>
          )}
        </div>
        <div className="text-sm text-muted-foreground">
          {draft.supplierName ? `${draft.supplierName} · ` : ""}
          {draft.recognized} поз. на {money(total)} ₽
        </div>
      </div>

      <div className="divide-y">
        {draft.items.map((item, index) => {
          const state = lines[index]
          const matched = state?.productId != null
          const pending = state?.newProduct != null
          const catalogName = state?.productId
            ? products.find((product) => product.id === state.productId)?.name
            : null
          return (
            <div key={`${item.rawName}-${index}`} className="grid gap-3 px-4 py-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,240px)_110px_120px] lg:items-center">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium" title={item.rawName}>
                  {item.rawName}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  {matched ? (
                    <span className="inline-flex items-center gap-1 text-green-700">
                      <Check className="h-3 w-3" />
                      {item.productName ?? catalogName}
                    </span>
                  ) : pending ? (
                    <span className="inline-flex items-center gap-1 text-primary">
                      <PackagePlus className="h-3 w-3" />
                      Будет создан товар «{state.newProduct?.name}»
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-amber-600">
                      <AlertTriangle className="h-3 w-3" />
                      Не найден в каталоге — выберите товар или создайте новый
                    </span>
                  )}
                  {(item.issues ?? []).map((issue) => (
                    <span key={issue} className="text-amber-600">· {issue}</span>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <Select
                  value={state?.productId ? String(state.productId) : "none"}
                  disabled={!editable}
                  onValueChange={(value) =>
                    update(index, {
                      productId: value === "none" ? null : Number(value),
                      // Picking a catalog product cancels the pending creation.
                      newProduct: null,
                    })
                  }
                >
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Выберите товар" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Не проводить</SelectItem>
                    {products.map((product) => (
                      <SelectItem key={product.id} value={String(product.id)}>
                        {product.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* Offered only while the line has nothing to post: a matched
                    product or an already prepared one needs no creation. */}
                {editable && !matched && !pending && (
                  <Button
                    type="button"
                    variant={pending ? "default" : "outline"}
                    size="sm"
                    className="h-9 shrink-0 gap-1.5"
                    title="Создать новый товар из этой строки"
                    aria-label={`Создать товар для ${item.rawName}`}
                    onClick={() => setCreatingFor(index)}
                  >
                    <PackagePlus className="h-4 w-4" />
                    Создать
                  </Button>
                )}
              </div>

              <Input
                className="h-9 text-right"
                type="number"
                min="0"
                step="0.01"
                disabled={!editable}
                value={state?.quantity ?? 0}
                onChange={(event) => update(index, { quantity: Number(event.target.value) })}
                aria-label={`Количество для ${item.rawName}`}
              />

              <Input
                className="h-9 text-right"
                type="number"
                min="0"
                step="0.01"
                disabled={!editable}
                value={state?.unitPrice ?? 0}
                onChange={(event) => update(index, { unitPrice: Number(event.target.value) })}
                aria-label={`Цена для ${item.rawName}`}
              />
            </div>
          )
        })}
      </div>

      <CreateProductFromInvoiceDialog
        open={creatingFor !== null}
        onOpenChange={(open) => {
          if (!open) setCreatingFor(null)
        }}
        item={creatingFor === null ? null : draft.items[creatingFor]}
        supplierName={draft.supplierName}
        onPrepared={(newProduct) => {
          if (creatingFor === null) return
          update(creatingFor, { newProduct, productId: null })
          setCreatingFor(null)
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3 border-t px-4 py-3">
        <div className="text-xs text-muted-foreground">
          {status === "applied" ? (
            <span className="inline-flex items-center gap-1 text-green-700">
              <Check className="h-3.5 w-3.5" />
              Приход проведён{appliedCount ? `: ${appliedCount} из ${draft.items.length} поз.` : ""}
            </span>
          ) : unresolved > 0 ? (
            `Готово к приходу ${readyLines.length} из ${draft.items.length} позиций`
          ) : (
            "Все позиции сопоставлены с каталогом"
          )}
        </div>
        {editable && (
          <Button
            type="button"
            disabled={isApplying || readyLines.length === 0}
            onClick={submit}
          >
            {isApplying ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Проводим...
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" />
                Провести приход{readyLines.length ? ` (${readyLines.length})` : ""}
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
