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
import { Bouquet, useUpdateBouquet, getListBouquetsQueryKey, useListProducts, getListProductsQueryKey, getGetDashboardQueryKey, useListBouquetCategories, getListBouquetCategoriesQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Plus, Trash2 } from "lucide-react"
import { useEffect, useMemo } from "react"
import { toast } from "sonner"
import { formatCurrency } from "@/lib/utils"
import { DEFAULT_BOUQUET_CATEGORY } from "./create-bouquet-dialog"

const bouquetSchema = z.object({
  name: z.string().min(1, "Обязательное поле"),
  // Категория букета: по ней букеты ищут и сортируют.
  category: z.string().min(1, "Обязательное поле"),
  markupPercent: z.coerce.number().min(0),
  components: z.array(z.object({
    productId: z.coerce.number().min(1, "Выберите товар"),
    quantity: z.coerce.number().min(0.01, "Количество должно быть больше 0")
  })).min(1, "Добавьте хотя бы один компонент")
})

export function EditBouquetDialog({ bouquet, open, onOpenChange }: { bouquet: Bouquet | null, open: boolean, onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  
  const { data: products } = useListProducts()
  const { data: categories } = useListBouquetCategories({
    query: { queryKey: getListBouquetCategoriesQueryKey() },
  })
  
  const stockProducts = useMemo(() => {
    return products?.filter(p => p.productType === 'stock') || []
  }, [products])

  const form = useForm<z.infer<typeof bouquetSchema>>({
    resolver: zodResolver(bouquetSchema),
    defaultValues: {
      name: "",
      category: DEFAULT_BOUQUET_CATEGORY,
      markupPercent: 0,
      components: []
    },
  })

  useEffect(() => {
    if (bouquet && open) {
      form.reset({
        name: bouquet.name,
        category: bouquet.category || DEFAULT_BOUQUET_CATEGORY,
        markupPercent: bouquet.markupPercent,
        components: bouquet.components.map(c => ({
          productId: c.productId,
          quantity: c.quantity
        }))
      })
    }
  }, [bouquet, open, form])

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "components"
  })

  const watchedComponents = form.watch("components")
  const watchedMarkup = form.watch("markupPercent")
  const cost = useMemo(
    () =>
      (watchedComponents ?? []).reduce((sum, component) => {
        const product = stockProducts.find((p) => p.id === Number(component.productId))
        return sum + Number(component.quantity || 0) * (product?.averagePrice || product?.purchasePrice || 0)
      }, 0),
    [watchedComponents, stockProducts],
  )

  const { mutate: updateBouquet, isPending } = useUpdateBouquet({
    mutation: {
      onSuccess: () => {
        toast.success("Букет успешно обновлен")
        queryClient.invalidateQueries({ queryKey: getListBouquetsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
        // Переименованная категория должна сразу обновиться в подсказках.
        queryClient.invalidateQueries({ queryKey: getListBouquetCategoriesQueryKey() })
        onOpenChange(false)
      },
      onError: () => {
        toast.error("Не удалось обновить букет")
      }
    }
  })

  function onSubmit(values: z.infer<typeof bouquetSchema>) {
    if (!bouquet) return
    updateBouquet({ id: bouquet.id, data: values })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Редактирование: {bouquet?.name}</DialogTitle>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Название букета</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Категория</FormLabel>
                    <FormControl>
                      <Input list="bouquet-categories-edit" {...field} />
                    </FormControl>
                    <datalist id="bouquet-categories-edit">
                      {(categories ?? []).map((item) => (
                        <option key={item} value={item} />
                      ))}
                    </datalist>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="markupPercent"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Наценка (%)</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <FormLabel className="text-base">Состав (компоненты)</FormLabel>
                <Button type="button" variant="outline" size="sm" onClick={() => append({ productId: 0, quantity: 1 })}>
                  <Plus className="mr-1 h-3 w-3" /> Добавить
                </Button>
              </div>
              
              {fields.length === 0 && (
                <div className="text-sm text-muted-foreground text-center py-4 border rounded-md border-dashed">
                  Нет компонентов. Добавьте цветы или упаковку.
                </div>
              )}

              {fields.map((field, index) => (
                <div key={field.id} className="flex gap-2 items-start">
                  <FormField
                    control={form.control}
                    name={`components.${index}.productId`}
                    render={({ field: f }) => (
                      <FormItem className="flex-1">
                        <Select onValueChange={(v) => f.onChange(Number(v))} value={f.value ? String(f.value) : undefined}>
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue placeholder="Выберите товар..." />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            {stockProducts.map((p) => (
                              <SelectItem key={p.id} value={String(p.id)}>
                                {p.name} {p.color ? `(${p.color})` : ''} - {p.currentStock} {p.unit}
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
                    name={`components.${index}.quantity`}
                    render={({ field: f }) => (
                      <FormItem className="w-24">
                        <FormControl>
                          <Input type="number" step="0.01" {...f} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="button" variant="ghost" size="icon" className="shrink-0 text-destructive mt-0" onClick={() => remove(index)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {form.formState.errors.components?.root && (
                <p className="text-sm font-medium text-destructive">{form.formState.errors.components.root.message}</p>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-1 rounded-lg bg-muted/50 px-4 py-3 text-sm">
              <span className="text-muted-foreground">
                Себестоимость: <span className="font-medium text-foreground">{formatCurrency(cost)}</span>
              </span>
              <span className="text-muted-foreground">
                Цена продажи по рецепту:{" "}
                <span className="font-medium text-foreground">
                  {formatCurrency(cost * (1 + Number(watchedMarkup || 0) / 100))}
                </span>
              </span>
            </div>

            <div className="flex justify-end pt-4 border-t">
              <Button type="submit" disabled={isPending || fields.length === 0}>
                {isPending ? "Сохранение..." : "Сохранить"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
