import { useEffect, useState } from "react"
import type { InvoiceDraftItem } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { PackagePlus } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { getListProductsQueryKey } from "@workspace/api-client-react"
import { toast } from "sonner"

const CATEGORIES = ["Цветы", "Упаковка", "Расходники", "Коробки", "Зелень"]
const UNITS = ["шт", "стебель", "м", "см", "упак.", "пачка", "рулон", "кг", "г", "л"]

export type NewProductDraft = {
  name: string
  aliases: string[]
  category: string
  variety: string
  color: string
  originCountry: string
  unit: string
  minimumStock: number
  markupPercent: number
  shelfLifeDays: number
}

/**
 * Creates a catalog product from an invoice line.
 *
 * The dialog only makes sense together with the arrival, so nothing is written
 * on save: the values are carried into the confirmation payload and the product
 * is inserted in the same transaction as its receipt.
 */
export function CreateProductFromInvoiceDialog({
  open,
  onOpenChange,
  item,
  supplierName,
  onPrepared,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  item: InvoiceDraftItem | null
  supplierName?: string | null
  onPrepared: (draft: NewProductDraft) => void
}) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<NewProductDraft | null>(null)

  useEffect(() => {
    if (!open || !item) return
    setForm({
      name: item.suggestedName || item.rawName,
      aliases: item.suggestedAliases?.length ? item.suggestedAliases : [item.rawName],
      category: item.suggestedCategory ?? "Цветы",
      variety: "",
      color: "",
      originCountry: supplierName ?? "",
      unit: item.suggestedUnit || item.unit || "шт",
      minimumStock: 0,
      markupPercent: item.suggestedMarkupPercent ?? 0,
      shelfLifeDays: item.suggestedShelfLifeDays ?? 0,
    })
  }, [open, item, supplierName])

  const update = (patch: Partial<NewProductDraft>) =>
    setForm((current) => (current ? { ...current, ...patch } : current))

  if (!item || !form) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent />
      </Dialog>
    )
  }

  const submit = () => {
    if (!form.name.trim()) {
      toast.error("Укажите название товара")
      return
    }
    queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
    onPrepared({
      ...form,
      name: form.name.trim(),
      aliases: form.aliases.map((alias) => alias.trim()).filter(Boolean),
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackagePlus className="h-5 w-5 text-primary" />
            Новый товар из накладной
          </DialogTitle>
          <DialogDescription>
            Позиция «{item.rawName}» — {item.quantity} × {item.unitPrice} ₽. Товар и приход по этой
            строке будут созданы вместе, когда вы подтвердите накладную.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Label htmlFor="invoice-product-name">Название</Label>
            <Input
              id="invoice-product-name"
              value={form.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </div>

          <div>
            <Label htmlFor="invoice-product-category">Категория</Label>
            <Select value={form.category} onValueChange={(value) => update({ category: value })}>
              <SelectTrigger id="invoice-product-category">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((category) => (
                  <SelectItem key={category} value={category}>
                    {category}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="invoice-product-unit">Единица</Label>
            <Select value={form.unit} onValueChange={(value) => update({ unit: value })}>
              <SelectTrigger id="invoice-product-unit">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {UNITS.map((unit) => (
                  <SelectItem key={unit} value={unit}>
                    {unit}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="invoice-product-variety">Сорт</Label>
            <Input
              id="invoice-product-variety"
              value={form.variety}
              placeholder="Необязательно"
              onChange={(event) => update({ variety: event.target.value })}
            />
          </div>

          <div>
            <Label htmlFor="invoice-product-color">Цвет</Label>
            <Input
              id="invoice-product-color"
              value={form.color}
              placeholder="Необязательно"
              onChange={(event) => update({ color: event.target.value })}
            />
          </div>

          <div>
            <Label htmlFor="invoice-product-markup">Наценка, %</Label>
            <Input
              id="invoice-product-markup"
              type="number"
              min="0"
              value={form.markupPercent}
              onChange={(event) => update({ markupPercent: Number(event.target.value) })}
            />
          </div>

          <div>
            <Label htmlFor="invoice-product-shelf-life">Срок годности, дней</Label>
            <Input
              id="invoice-product-shelf-life"
              type="number"
              min="0"
              value={form.shelfLifeDays}
              onChange={(event) => update({ shelfLifeDays: Number(event.target.value) })}
            />
          </div>

          <div>
            <Label htmlFor="invoice-product-minimum">Минимальный остаток</Label>
            <Input
              id="invoice-product-minimum"
              type="number"
              min="0"
              value={form.minimumStock}
              onChange={(event) => update({ minimumStock: Number(event.target.value) })}
            />
          </div>

          <div>
            <Label htmlFor="invoice-product-aliases">Псевдонимы (через запятую)</Label>
            <Input
              id="invoice-product-aliases"
              value={form.aliases.join(", ")}
              onChange={(event) =>
                update({ aliases: event.target.value.split(",").map((value) => value.trim()) })
              }
            />
          </div>
        </div>

        <p className="text-xs text-muted-foreground">
          Закупочная цена {item.unitPrice} ₽ будет взята из накладной, цена продажи посчитается от
          неё с указанной наценкой.
        </p>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button type="button" onClick={submit}>
            Создать и привязать к строке
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
