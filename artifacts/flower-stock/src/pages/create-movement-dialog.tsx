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
import { Checkbox } from "@/components/ui/checkbox"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useCreateMovement, getListMovementsQueryKey, getGetDashboardQueryKey, getListProductsQueryKey, useListProducts, useListProductReceipts, useListBouquetStockBatches, getListBouquetsQueryKey } from "@workspace/api-client-react"
import { useQueryClient } from "@tanstack/react-query"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog"
import { Plus } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { formatDate } from "@/lib/utils"
import { describeMovementForNotice } from "@/lib/movement-types"

const movementSchema = z.object({
  productId: z.coerce.number().min(1, "Выберите товар"),
  type: z.enum(["receipt", "expense", "production_input", "writeoff", "transfer"]),
  quantity: z.coerce.number().min(0.01, "Укажите количество больше 0"),
  unitPrice: z.coerce.number().min(0).optional(),
  saleUnitPrice: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.coerce.number().min(0, "Цена не может быть отрицательной").optional(),
  ),
  markupPercent: z.coerce.number().min(0).optional(),
  // Партия, из которой списываем. Пусто — расход по порядку поступления.
  receiptMovementId: z.preprocess(
    (value) => (value === "" || value === "any" ? undefined : value),
    z.coerce.number().int().positive().optional(),
  ),
  reason: z.string().optional(),
  batchArrivalDate: z.string().optional(),
  // Операция, которая не должна попасть в отчёты: товар добавили по ошибке или
  // списывают то, чего в магазине не было. Остаток меняется, статистика — нет.
  excludeFromStats: z.boolean().optional(),
  // Сборка букета, из которой списываем: у каждой свой состав и своя цена.
  productionBatchId: z.preprocess(
    (value) => (value === "" || value === "any" ? undefined : value),
    z.string().optional(),
  ),
})

type MovementValues = z.infer<typeof movementSchema>

/**
 * Виды операций для выбора кнопками.
 *
 * Порядок — от частого к редкому: приход и продажа случаются каждый день,
 * списание брака — реже.
 *
 * Расхода «в сборку» здесь нет намеренно: он только списывал товар и ничего не
 * создавал, а рядом на вкладке «Букеты» есть настоящая сборка — она списывает
 * состав, добавляет готовый букет и запоминает его себестоимость. Две похожие
 * кнопки с разным результатом только путали.
 */
const MOVEMENT_TYPES: Array<{ value: MovementValues["type"]; label: string }> = [
  { value: "receipt", label: "Приход" },
  { value: "expense", label: "Продажа" },
  { value: "writeoff", label: "Списание" },
]

/**
 * Букет расходуется только из конкретной сборки.
 *
 * Правило одно для формы и проверки перед отправкой: у каждой сборки свой состав
 * и своя себестоимость, и «средний» расход размазал бы её по всем. Сервер это
 * тоже проверяет — здесь причина показывается до запроса.
 */
function bouquetNeedsBatch(
  values: Pick<MovementValues, "type" | "productionBatchId">,
  isBouquet: boolean,
) {
  return (
    isBouquet &&
    (values.type === "expense" || values.type === "writeoff") &&
    !values.productionBatchId
  )
}

type CreateMovementDialogProps = {
  initialProductId?: number
  triggerLabel?: string
  compact?: boolean
  /** Stretch the trigger to its container — used by the mobile card list. */
  fullWidth?: boolean
}

export function CreateMovementDialog({
  initialProductId = 0,
  triggerLabel = "Новая операция",
  compact = false,
  fullWidth = false,
}: CreateMovementDialogProps = {}) {
  const [open, setOpen] = useState(false)
  const queryClient = useQueryClient()
  const { data: products } = useListProducts()
  
  const form = useForm<z.infer<typeof movementSchema>>({
    resolver: zodResolver(movementSchema),
    defaultValues: {
      productId: initialProductId,
      type: "receipt",
      quantity: 1,
      unitPrice: 0,
      saleUnitPrice: undefined,
      markupPercent: 100,
      reason: "",
      batchArrivalDate: new Date().toISOString().slice(0, 10),
      excludeFromStats: false,
    },
  })

  const { mutate: createMovement, isPending } = useCreateMovement({
    mutation: {
      onSuccess: (movement) => {
        // В уведомлении — что именно записалось: вид операции, товар, количество
        // с единицей и деньги. «Операция успешно проведена» не отвечает на вопрос
        // «а что я только что провёл?».
        toast.success("Операция проведена", {
          description: describeMovementForNotice(movement),
          duration: 6000,
        })
        queryClient.invalidateQueries({ queryKey: getListMovementsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        setOpen(false)
        form.reset({
          productId: initialProductId,
          type: "receipt",
          quantity: 1,
          unitPrice: 0,
          saleUnitPrice: undefined,
          markupPercent: 100,
          reason: "",
          receiptMovementId: undefined,
          productionBatchId: undefined,
          batchArrivalDate: new Date().toISOString().slice(0, 10),
          excludeFromStats: false,
        })
      },
      onError: () => {
        toast.error("Ошибка при проведении операции")
      }
    }
  })

  function onSubmit(values: MovementValues) {
    if (bouquetNeedsBatch(values, isBouquet)) {
      toast.error("Выберите сборку: без неё букет не списать")
      return
    }
    // Пустые строки вместо отсутствующих полей — обычное дело для формы:
    // сервер ждёт либо приход, либо сборку, а не пустую строку в каждом.
    createMovement({
      data: {
        ...values,
        receiptMovementId: values.receiptMovementId ?? null,
        productionBatchId: values.productionBatchId || null,
      },
    })
  }

  const type = form.watch("type")
  const watchedProductId = form.watch("productId")

  // Партии показываем только для списания: приход партию создаёт, а не расходует.
  // Сгенерированный хук требует queryKey в типе опций, хотя useQuery подставляет
  // его сам, поэтому передаём только enabled.
  const needsBatchChoice = type === "expense" || type === "writeoff"
  const { data: receipts } = useListProductReceipts(Number(watchedProductId) || 0, {
    query: { enabled: needsBatchChoice && Boolean(watchedProductId) },
  } as never)
  const availableBatches = (receipts ?? []).filter(
    (receipt) => (receipt.remainingQuantity ?? 0) > 0,
  )
  const selectedProduct = products?.find((item) => item.id === Number(watchedProductId))
  // У букета партий-приходов нет: он лежит на складе сборками, и продавать его
  // нужно из конкретной — со своим составом и своей ценой.
  const isBouquet = selectedProduct?.productType === "bouquet"
  const { data: bouquetBatches } = useListBouquetStockBatches(
    { bouquetId: Number(watchedProductId) || 0 },
    { query: { enabled: needsBatchChoice && isBouquet } } as never,
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant={compact ? "outline" : "default"}
          size={compact ? "sm" : "default"}
          className={fullWidth ? "h-11 w-full" : "h-11 md:h-10"}
        >
          <Plus className="mr-2 h-4 w-4" />
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Проведение операции</DialogTitle>
        </DialogHeader>
        
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="type"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Тип операции</FormLabel>
                  {/* Кнопки вместо выпадающего списка: видов операции всего
                      три, и выбор виден сразу — не нужно открывать список,
                      чтобы вспомнить, что там есть. На телефоне две кнопки в
                      ряд, третья занимает всю ширину: половина строки пустой
                      выглядела бы обрезанной. */}
                  <div className="flex flex-wrap gap-2" role="group" aria-label="Тип операции">
                    {MOVEMENT_TYPES.map((option) => (
                      <Button
                        key={option.value}
                        type="button"
                        variant={field.value === option.value ? "default" : "outline"}
                        className="h-11 grow basis-[calc(50%-0.25rem)] px-3 last:grow sm:h-10 sm:grow-0 sm:basis-auto"
                        aria-pressed={field.value === option.value}
                        onClick={() => field.onChange(option.value)}
                      >
                        {option.label}
                      </Button>
                    ))}
                  </div>
                  <FormMessage />
                </FormItem>
              )}
            />
            
            <FormField
              control={form.control}
              name="productId"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Товар</FormLabel>
                  <Select
                    onValueChange={(value) => {
                      field.onChange(value)
                      // Партия прежнего товара к новому не относится: без сброса
                      // сервер получил бы чужой приход или чужую сборку.
                      form.setValue("receiptMovementId", undefined)
                      form.setValue("productionBatchId", undefined)
                    }}
                    value={field.value ? String(field.value) : undefined}
                  >
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue placeholder="Выберите товар" />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {products?.map(p => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name} {p.variety ? `(${p.variety})` : ''} - в наличии: {p.currentStock} {p.unit}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="quantity"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Количество</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              
              {type === "receipt" && (
                <>
                  <FormField
                    control={form.control}
                    name="unitPrice"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Цена за единицу (Закупка)</FormLabel>
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
                        <FormLabel>Наценка (%)</FormLabel>
                        <FormControl>
                          <Input type="number" step="0.1" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </>
              )}
            </div>

            {type === "expense" && (
              <FormField
                control={form.control}
                name="saleUnitPrice"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Цена продажи за единицу (необязательно)</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="Если пусто — текущая цена товара"
                        {...field}
                        value={field.value ?? ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {type === "receipt" && (
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
            )}

            {/* Какую партию расходуем. По умолчанию — по порядку поступления,
                но кладовщик может указать конкретный приход; у букета —
                конкретную сборку, со своим составом и своей ценой. */}
            {needsBatchChoice && (
              <FormField
                control={form.control}
                name={isBouquet ? "productionBatchId" : "receiptMovementId"}
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>{isBouquet ? "Списать из сборки" : "Списать из прихода"}</FormLabel>
                    <Select
                      onValueChange={(value) =>
                        field.onChange(value === "any" ? undefined : value)
                      }
                      value={field.value ? String(field.value) : isBouquet ? undefined : "any"}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Автоматически" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {/* У букета выбора «автоматически» нет: сборку нужно
                            назвать, иначе непонятно, из какой списывать. */}
                        {!isBouquet && (
                          <SelectItem value="any">
                            Автоматически — сначала самые старые
                          </SelectItem>
                        )}
                        {isBouquet
                          ? (bouquetBatches ?? []).map((batch) => (
                              <SelectItem key={batch.id} value={batch.id}>
                                {formatDate(batch.createdAt)} — остаток {batch.remainingQuantity} шт
                                {batch.salePrice ? `, продажа по ${batch.salePrice} ₽` : ""}
                              </SelectItem>
                            ))
                          : availableBatches.map((receipt) => (
                              <SelectItem key={receipt.id} value={String(receipt.id)}>
                                {receipt.batchArrivalDate || String(receipt.createdAt).slice(0, 10)}
                                {" — остаток "}
                                {receipt.remainingQuantity} {selectedProduct?.unit ?? "ед."}
                                {receipt.unitPrice ? ` по ${receipt.unitPrice} ₽` : ""}
                              </SelectItem>
                            ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                    {isBouquet && (bouquetBatches ?? []).length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        Свободных сборок нет — сначала соберите букет на вкладке «Букеты».
                      </p>
                    )}
                    {!isBouquet && needsBatchChoice && availableBatches.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        У товара нет партий с остатком — списание пойдёт из общего остатка.
                      </p>
                    )}
                  </FormItem>
                )}
              />
            )}

            <FormField
              control={form.control}
              name="reason"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Комментарий / Причина</FormLabel>
                  <FormControl>
                    <Input placeholder="Например: Поставка от Эквадор-Трейд" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Пометка «не в статистику». Показываем только там, где она
                осмысленна: приход, добавленный по ошибке, и списание того, чего
                в магазине не было. Продажа — это всегда выручка, исключать её
                из отчётов незачем. */}
            {(type === "writeoff" || type === "receipt") && (
              <FormField
                control={form.control}
                name="excludeFromStats"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start gap-3 rounded-lg border p-3">
                    <FormControl>
                      <Checkbox
                        checked={field.value === true}
                        onCheckedChange={(checked) => field.onChange(checked === true)}
                        aria-label="Не учитывать операцию в статистике"
                        className="mt-0.5 h-6 w-6"
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel className="cursor-pointer">
                        Не учитывать в статистике
                      </FormLabel>
                      <p className="text-xs text-muted-foreground">
                        Остаток изменится, в истории операция останется, но в выручку,
                        себестоимость и графики не попадёт. Ставьте, если товар добавлен
                        по ошибке или списывается то, чего в магазине не было.
                      </p>
                    </div>
                  </FormItem>
                )}
              />
            )}

            <div className="flex justify-end pt-4">
              <Button type="submit" disabled={isPending}>
                {isPending ? "Обработка..." : "Провести"}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
