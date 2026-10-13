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
import { useCreateProduct, getListProductsQueryKey, getGetDashboardQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Plus } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"

const productSchema = z.object({
  name: z.string().min(1, "Обязательное поле"),
  aliasesText: z.string(),
  category: z.string().min(1, "Обязательное поле"),
  variety: z.string().optional(),
  color: z.string().optional(),
  supplier: z.string().optional(),
  unit: z.string().min(1, "Обязательное поле").default("шт"),
  minimumStock: z.coerce.number().min(0),
  shelfLifeDays: z.coerce.number().min(0),
})

const units = ["шт", "стебель", "м", "см", "упак.", "пачка", "рулон", "кг", "г", "л"]
const categories = ["Цветы", "Упаковка", "Расходники", "Коробки", "Зелень"]

export function CreateProductDialog() {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  
  const form = useForm<z.infer<typeof productSchema>>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: "",
      aliasesText: "",
      category: "",
      variety: "",
      color: "",
      supplier: "",
      unit: "шт",
      minimumStock: 10,
      shelfLifeDays: 14,
    },
  })

  const { mutate: createProduct, isPending } = useCreateProduct({
    mutation: {
      onSuccess: () => {
        toast.success("Товар успешно добавлен")
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
        setOpen(false)
        form.reset()
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось добавить товар")
      }
    }
  })

  function onSubmit(values: z.infer<typeof productSchema>) {
    const { aliasesText, ...data } = values
    createProduct({
      data: {
        ...data,
        aliases: aliasesText.split(",").map((alias) => alias.trim()).filter(Boolean),
      },
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-11 md:h-10">
          <Plus className="mr-2 h-4 w-4" />
          Добавить товар
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px]">
        <DialogHeader>
          <DialogTitle>Новый товар</DialogTitle>
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
                      <Input placeholder="Роза Эквадор" {...field} />
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
                      Через запятую. Один псевдоним можно использовать только у одного товара.
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
                      <Input placeholder="Freedom" {...field} />
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
                      <Input placeholder="Красный" {...field} />
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
                {isPending ? "Сохранение..." : "Сохранить товар"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
