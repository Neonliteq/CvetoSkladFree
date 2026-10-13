import { useForm } from "react-hook-form"
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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Product, useUpdateProduct, getListProductsQueryKey, getGetDashboardQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { toast } from "sonner"
import { useEffect } from "react"

const productSchema = z.object({
  name: z.string().min(1, "Обязательное поле"),
  aliasesText: z.string(),
  category: z.string().min(1, "Обязательное поле"),
  variety: z.string().optional(),
  color: z.string().optional(),
  unit: z.string().min(1, "Обязательное поле"),
  minimumStock: z.coerce.number().min(0),
  shelfLifeDays: z.coerce.number().min(0),
})

const units = ["шт", "стебель", "м", "см", "упак.", "пачка", "рулон", "кг", "г", "л"]
const categories = ["Цветы", "Упаковка", "Расходники", "Коробки", "Зелень"]

export function EditProductDialog({ product, open, onOpenChange }: { product: Product | null, open: boolean, onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  
  const form = useForm<z.infer<typeof productSchema>>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: "",
      aliasesText: "",
      category: "",
      variety: "",
      color: "",
      unit: "шт",
      minimumStock: 0,
      shelfLifeDays: 0,
    },
  })

  useEffect(() => {
    if (product && open) {
      form.reset({
        name: product.name,
        aliasesText: product.aliases.join(", "),
        category: product.category,
        variety: product.variety || "",
        color: product.color || "",
        unit: product.unit,
        minimumStock: product.minimumStock,
        shelfLifeDays: product.shelfLifeDays,
      })
    }
  }, [product, open, form])

  const { mutate: updateProduct, isPending } = useUpdateProduct({
    mutation: {
      onSuccess: () => {
        toast.success("Товар успешно обновлен")
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
        onOpenChange(false)
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось обновить товар")
      }
    }
  })

  function onSubmit(values: z.infer<typeof productSchema>) {
    if (!product) return
    const { aliasesText, ...data } = values
    updateProduct({
      id: product.id,
      data: {
        ...data,
        aliases: aliasesText.split(",").map((alias) => alias.trim()).filter(Boolean),
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Редактирование: {product?.name}</DialogTitle>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Название</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="aliasesText"
                render={({ field }) => (
                  <FormItem className="col-span-2">
                    <FormLabel>Другие названия</FormLabel>
                    <FormControl>
                      <Input placeholder="пиончики, коралл" {...field} />
                    </FormControl>
                    <p className="text-xs text-muted-foreground">
                      Через запятую. Ассистент будет узнавать товар по этим названиям.
                    </p>
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
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Выберите категорию" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {categories.map((category) => (
                          <SelectItem key={category} value={category}>{category}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="variety"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Сорт</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="color"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Цвет</FormLabel>
                    <FormControl>
                      <Input {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="unit"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Ед. изм.</FormLabel>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Выберите единицу" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {units.map((unit) => (
                          <SelectItem key={unit} value={unit}>{unit}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="minimumStock"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Мин. остаток</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="shelfLifeDays"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Срок жизни (дней)</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="flex justify-end pt-4">
              <Button type="submit" disabled={isPending}>
                {isPending ? "Сохранение..." : "Сохранить"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
