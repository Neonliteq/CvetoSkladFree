import { useEffect, useMemo } from "react"
import { useForm, useFieldArray } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Bouquet,
  useProduceBouquet,
  useListProducts,
  getListBouquetsQueryKey,
  getListProductsQueryKey,
  getListMovementsQueryKey,
  getGetDashboardQueryKey,
  getGetMovementAnalyticsQueryKey,
  getListProductionBatchesQueryKey,
} from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "sonner"
import { Plus, Trash2, TriangleAlert } from "lucide-react"
import { formatCurrency } from "@/lib/utils"

const produceSchema = z.object({
  quantity: z.coerce.number().int("Целое число").min(1, "Минимум 1"),
  salePrice: z.coerce.number().min(0, "Цена не может быть отрицательной"),
  ingredients: z
    .array(
      z.object({
        productId: z.coerce.number().min(1, "Выберите товар"),
        quantity: z.coerce.number().positive("Количество должно быть больше 0"),
      }),
    )
    .min(1, "В букете должна быть хотя бы одна позиция"),
})

type ProduceValues = z.infer<typeof produceSchema>

/**
 * Производство букета.
 *
 * Состав здесь редактируемый: в работе цветок часто заменяют, и со склада
 * должно списаться именно то, что реально ушло в букет. Цена продажи тоже
 * ставится по факту — она записывается в партию сборки, а рецепт не меняется.
 */
export function ProduceBouquetDialog({
  bouquet,
  open,
  onOpenChange,
}: {
  bouquet: Bouquet | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const queryClient = useQueryClient()
  const { data: products } = useListProducts()
  const stockProducts = useMemo(
    () => (products ?? []).filter((product) => product.productType === "stock"),
    [products],
  )

  const form = useForm<ProduceValues>({
    resolver: zodResolver(produceSchema),
    defaultValues: { quantity: 1, salePrice: 0, ingredients: [] },
  })

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "ingredients",
  })

  useEffect(() => {
    if (!open || !bouquet) return
    form.reset({
      quantity: 1,
      salePrice: bouquet.lastProduction?.salePrice ?? bouquet.salePrice,
      ingredients: bouquet.components.map((component) => ({
        productId: component.productId,
        quantity: component.quantity,
      })),
    })
  }, [open, bouquet, form])

  const values = form.watch()
  const quantity = Number(values.quantity) || 1

  /** Закупочная цена позиции: та же, по которой считается себестоимость сборки. */
  const priceOf = (productId: number) => {
    const product = stockProducts.find((item) => item.id === Number(productId))
    return product?.averagePrice || product?.purchasePrice || 0
  }
  const stockOf = (productId: number) => {
    const product = stockProducts.find((item) => item.id === Number(productId))
    return product?.currentStock ?? 0
  }
  const unitOf = (productId: number) =>
    stockProducts.find((item) => item.id === Number(productId))?.unit ?? "шт"

  const costPerUnit = (values.ingredients ?? []).reduce(
    (sum, ingredient) => sum + Number(ingredient.quantity || 0) * priceOf(Number(ingredient.productId)),
    0,
  )
  const salePrice = Number(values.salePrice) || 0
  const margin = salePrice - costPerUnit
  const marginPercent = costPerUnit > 0 ? (margin / costPerUnit) * 100 : 0

  /** Позиции, которых не хватает на выбранное количество: показываем до запуска. */
  const shortages = (values.ingredients ?? [])
    .map((ingredient) => {
      const productId = Number(ingredient.productId)
      const need = Number(ingredient.quantity || 0) * quantity
      const have = stockOf(productId)
      return { productId, need, have, productName: stockProducts.find((p) => p.id === productId)?.name }
    })
    .filter((item) => item.productId > 0 && item.need > item.have)

  /** Позиция, выбранная в другой строке: один товар двумя строками сбивает учёт. */
  const duplicateIds = new Set(
    (values.ingredients ?? [])
      .map((ingredient) => Number(ingredient.productId))
      .filter((productId, index, all) => productId > 0 && all.indexOf(productId) !== index),
  )

  const { mutate: produceBouquet, isPending } = useProduceBouquet({
    mutation: {
      onSuccess: (result) => {
        // Что именно собрали: сколько букетов, по какой цене и во сколько они
        // обошлись. Состав здесь не перечисляем — он виден в истории сборок.
        const batch = result?.batch
        const price = batch?.salePrice ?? bouquet?.salePrice ?? 0
        const cost = batch?.calculatedCost ?? 0
        toast.success("Букет собран", {
          description: [
            `${result?.bouquet?.name ?? bouquet?.name}: +${result?.quantity ?? 1} шт`,
            `продажа по ${formatCurrency(price)}`,
            cost > 0 ? `себестоимость ${formatCurrency(cost)}` : null,
          ]
            .filter(Boolean)
            .join(" · "),
          duration: 6000,
        })
        queryClient.invalidateQueries({ queryKey: getListBouquetsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListMovementsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetMovementAnalyticsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListProductionBatchesQueryKey() })
        onOpenChange(false)
      },
      onError: (err: any) => {
        toast.error(err?.data?.error || "Не удалось собрать букет. Возможно, не хватает компонентов.")
      },
    },
  })

  function onSubmit(data: ProduceValues) {
    if (!bouquet) return
    if (duplicateIds.size) {
      toast.error("Один товар указан в составе дважды — объедините строки")
      return
    }
    produceBouquet({
      id: bouquet.id,
      data: {
        quantity: data.quantity,
        salePrice: data.salePrice,
        ingredients: data.ingredients,
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[680px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Производство: {bouquet?.name}</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="quantity"
                render={({ field }) => (
                  <FormItem className="min-w-0">
                    <FormLabel>Сколько букетов</FormLabel>
                    <FormControl>
                      <Input type="number" min={1} className="w-full" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="salePrice"
                render={({ field }) => (
                  <FormItem className="min-w-0">
                    <FormLabel>Цена продажи за штуку</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" className="w-full" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <FormLabel className="text-base">Состав этой сборки</FormLabel>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append({ productId: 0, quantity: 1 })}
                >
                  <Plus className="mr-1 h-3 w-3" /> Добавить
                </Button>
              </div>
              <p className="-mt-2 text-xs text-muted-foreground">
                Состав взят из рецепта. Если цветок заменили — поменяйте позицию здесь: со склада
                спишется именно это.
              </p>

              {fields.map((field, index) => {
                const productId = Number(form.watch(`ingredients.${index}.productId`))
                const rowQuantity = Number(form.watch(`ingredients.${index}.quantity`)) || 0
                const lineCost = rowQuantity * priceOf(productId)
                return (
                  // На телефоне строка состава переносится: выбор товара во всю
                  // ширину, под ним количество, стоимость и удаление. В одну
                  // строку на 360 px это не влезает и уезжает за край диалога.
                  <div key={field.id} className="flex flex-wrap items-start gap-2">
                    <FormField
                      control={form.control}
                      name={`ingredients.${index}.productId`}
                      render={({ field: f }) => (
                        <FormItem className="w-full min-w-0 sm:flex-1">
                          <Select
                            onValueChange={(value) => f.onChange(Number(value))}
                            value={f.value ? String(f.value) : undefined}
                          >
                            <FormControl>
                              <SelectTrigger
                                className={`w-full ${duplicateIds.has(Number(f.value)) ? "border-destructive" : ""}`}
                              >
                                <SelectValue placeholder="Выберите товар..." />
                              </SelectTrigger>
                            </FormControl>
                            <SelectContent>
                              {stockProducts.map((product) => (
                                <SelectItem key={product.id} value={String(product.id)}>
                                  {product.name}
                                  {product.color ? ` (${product.color})` : ""} — {product.currentStock}{" "}
                                  {product.unit}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`ingredients.${index}.quantity`}
                      render={({ field: f }) => (
                        <FormItem className="w-24 shrink-0">
                          {/* Подпись видна только программе чтения с экрана: в
                              строке состава место занято полем выбора товара. */}
                          <FormLabel className="sr-only">Количество в букете</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              step="0.01"
                              aria-label={`Количество в букете, позиция ${index + 1}`}
                              {...f}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <div className="flex flex-1 items-center justify-end gap-1">
                      <div className="text-right text-sm text-muted-foreground">
                        {formatCurrency(lineCost)}
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 shrink-0 text-destructive"
                        aria-label="Убрать позицию"
                        onClick={() => remove(index)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </div>
                )
              })}
              <div className="flex justify-end text-xs text-muted-foreground">
                Себестоимость за штуку: {formatCurrency(costPerUnit)}
              </div>
              {form.formState.errors.ingredients?.root && (
                <p className="text-sm font-medium text-destructive">
                  {form.formState.errors.ingredients.root.message}
                </p>
              )}
            </div>

            {shortages.length > 0 && (
              <div className="flex gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                <div>
                  <div className="font-medium text-destructive">Не хватает на складе</div>
                  <ul className="mt-1 space-y-0.5 text-muted-foreground">
                    {shortages.map((item) => (
                      <li key={item.productId}>
                        {item.productName}: нужно {item.need} {unitOf(item.productId)}, есть {item.have}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3 rounded-lg bg-muted/50 px-4 py-3 text-sm">
              <div>
                <div className="text-xs text-muted-foreground">Себестоимость сборки</div>
                <div className="font-medium">{formatCurrency(costPerUnit * quantity)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Выручка</div>
                <div className="font-medium">{formatCurrency(salePrice * quantity)}</div>
              </div>
              <div>
                <div className="text-xs text-muted-foreground">Прибыль</div>
                <div className={`font-medium ${margin < 0 ? "text-destructive" : ""}`}>
                  {formatCurrency(margin * quantity)}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({marginPercent >= 0 ? "+" : ""}
                    {marginPercent.toFixed(0)}%)
                  </span>
                </div>
              </div>
            </div>

            <div className="flex justify-end border-t pt-4">
              <Button type="submit" disabled={isPending || fields.length === 0}>
                {isPending ? "Производство..." : "Собрать"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
