import { useState } from "react"
import type {
  AssistantClarification,
  AssistantClarificationOption,
  AssistantPlan,
} from "@workspace/api-client-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { AlertTriangle, Check, ChevronDown, CircleHelp, Loader2, Search, Sparkles, Undo2 } from "lucide-react"

/**
 * Выбор товара для спорной позиции.
 *
 * Вариантов бывает много: на слово «роза» каталог отдаёт все розы, включая
 * случайные совпадения. Поэтому первые несколько показываются кнопками — их
 * удобно нажать сразу, — а полный список открывается в выпадающем окне с
 * поиском: так нужный товар находится и когда вариантов двадцать.
 */
function ClarificationOptions({
  clarification,
  editable,
  isApplying,
  onSelectOption,
}: {
  clarification: AssistantClarification
  editable: boolean
  isApplying: boolean
  onSelectOption: (clarification: AssistantClarification, option: AssistantClarificationOption) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")

  const inlineLimit = 4
  const inline = clarification.options.slice(0, inlineLimit)
  const rest = clarification.options.slice(inlineLimit)
  const normalizedQuery = query.trim().toLocaleLowerCase("ru")
  const filtered = normalizedQuery
    ? clarification.options.filter((option) =>
        option.name.toLocaleLowerCase("ru").includes(normalizedQuery),
      )
    : clarification.options

  const optionRow = (option: AssistantClarificationOption, inlineRow: boolean) => {
    const picked = clarification.selectedProductId === option.id
    return (
      <Button
        key={option.id}
        type="button"
        variant={picked ? "default" : "outline"}
        // Full-width and thumb-sized on a phone: the whole point is to pick a
        // product by tapping instead of retyping.
        className="h-auto min-h-11 w-full justify-between gap-2 px-3 py-2 text-left md:min-h-10"
        disabled={!editable || isApplying}
        aria-label={`Выбрать товар ${option.name}, остаток ${option.stock} ${option.unit}`}
        onClick={() => {
          if (!inlineRow) setOpen(false)
          onSelectOption(clarification, option)
        }}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {picked && <Check className="h-4 w-4 shrink-0" />}
          <span className="min-w-0 whitespace-normal break-words text-sm">{option.name}</span>
        </span>
        <span className={`shrink-0 text-xs font-normal ${picked ? "" : "text-muted-foreground"}`}>
          {`остаток ${option.stock} ${option.unit}`}
        </span>
      </Button>
    )
  }

  const selected = clarification.options.find(
    (option) => option.id === clarification.selectedProductId,
  )

  return (
    <div className="mt-2 space-y-2">
      <div className="grid gap-2 sm:grid-cols-2">
        {inline.map((option) => optionRow(option, true))}
      </div>

      {clarification.options.length > inlineLimit && (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full justify-between gap-2 px-3 text-sm font-normal md:h-10"
              disabled={!editable || isApplying}
              aria-label={`Показать все товары для «${clarification.asked}», всего ${clarification.options.length}`}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Search className="h-4 w-4 shrink-0" />
                <span className="truncate">
                  {selected && !inline.some((option) => option.id === selected.id)
                    ? selected.name
                    : `Ещё товары (${rest.length})`}
                </span>
              </span>
              <ChevronDown className="h-4 w-4 shrink-0 opacity-60" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[min(92vw,26rem)] p-2">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Поиск по названию"
              className="mb-2 h-10"
              aria-label={`Поиск товара для «${clarification.asked}»`}
            />
            <div className="max-h-64 space-y-1 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="px-2 py-3 text-sm text-muted-foreground">Ничего не найдено</p>
              ) : (
                filtered.map((option) => optionRow(option, false))
              )}
            </div>
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

/** How far the breakdown has got: waiting for the user, written or reverted. */
export type PlanReviewState = {
  status: "pending" | "applied" | "undone"
  /** Set once the set is written; the id reverts the whole batch at once. */
  batchId: string | null
  appliedCount: number
  errors: string[]
  answer?: string
}

const TYPE_LABELS: Record<string, string> = {
  receipt: "Приход",
  expense: "Продажа",
  writeoff: "Списание",
  production_input: "Сборка",
}

const typeLabel = (type: string) => TYPE_LABELS[type] ?? type

/** Same wording the assistant uses in its own preview text. */
const operationText = (operation: {
  type: string
  quantity: number
  unit: string
  productName: string
  description?: string
}) =>
  operation.description ??
  `${typeLabel(operation.type)}: ${operation.quantity} ${operation.unit} «${operation.productName}»`

/**
 * Review card for a composite command.
 *
 * A command with several positions, or with a doubtful one, is never written
 * right away: the user sees the breakdown, picks a product for every doubtful
 * position and confirms the whole set with one button. Nothing is posted from
 * this component on its own.
 */
export function AssistantPlanCard({
  plan,
  review,
  isApplying,
  isUndoing,
  onApply,
  onSelectOption,
  onUndoBatch,
}: {
  plan: AssistantPlan
  review: PlanReviewState
  isApplying: boolean
  isUndoing: boolean
  onApply: (plan: AssistantPlan) => void
  onSelectOption: (clarification: AssistantClarification, option: AssistantClarificationOption) => void
  onUndoBatch: (batchId: string) => void
}) {
  const editable = review.status === "pending"
  // Writing is impossible while any doubtful position is still open — the user
  // closes it by tapping an option — so the confirm button stays disabled
  // instead of failing on the server.
  const canApply = plan.operations.length > 0 && plan.clarifications.length === 0 && !isApplying
  const undoable = review.status === "applied" && Boolean(review.batchId) && review.appliedCount > 0

  return (
    <div className="w-full rounded-xl border bg-card shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-3 md:px-4">
        <div className="flex min-w-0 items-center gap-2">
          <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          <span className="font-medium">Разбор команды</span>
          <Badge variant="outline" className="shrink-0 font-normal">
            {plan.operations.length + plan.clarifications.length} поз.
          </Badge>
        </div>
        {editable && plan.clarifications.length > 0 && (
          <Badge variant="warning" className="shrink-0">
            Нужно уточнить
          </Badge>
        )}
        {review.status === "applied" && (
          <Badge variant="success" className="shrink-0">
            Проведено
          </Badge>
        )}
        {review.status === "undone" && (
          <Badge variant="secondary" className="shrink-0">
            Набор отменён
          </Badge>
        )}
      </div>

      {plan.operations.length > 0 && (
        <ul className="divide-y">
          {plan.operations.map((operation) => (
            <li
              key={`op-${operation.index}`}
              className="flex items-start gap-2 px-3 py-2.5 text-sm md:px-4"
            >
              <Check className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />
              <span className="min-w-0">{operationText(operation)}</span>
            </li>
          ))}
        </ul>
      )}

      {plan.clarifications.map((clarification) => (
        <div key={`cl-${clarification.index}`} className="border-t px-3 py-3 md:px-4">
          <div className="flex items-start gap-2">
            <CircleHelp className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {`${typeLabel(clarification.type)}: «${clarification.asked}» — ${clarification.quantity} ед.`}
              </p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {clarification.description ??
                  clarification.message ??
                  "Выберите товар — операция проведётся сразу."}
              </p>
            </div>
          </div>
          {clarification.options.length > 0 ? (
            <ClarificationOptions
              clarification={clarification}
              editable={editable}
              isApplying={isApplying}
              onSelectOption={onSelectOption}
            />
          ) : (
            <p className="mt-2 text-xs text-amber-600">
              {clarification.message ?? "Товар не распознан — назовите его точнее."}
            </p>
          )}
        </div>
      ))}

      {review.errors.length > 0 && (
        <div className="border-t px-3 py-3 md:px-4">
          <div className="flex items-start gap-2 text-sm text-amber-700">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <ul className="min-w-0 space-y-1">
              {review.errors.map((error, index) => (
                <li key={`${error}-${index}`} className="break-words">
                  {error}
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {editable && (
        <div className="flex flex-col gap-2 border-t px-3 py-3 sm:flex-row sm:items-center sm:justify-between md:px-4">
          <p className="text-xs text-muted-foreground">
            {plan.clarifications.length > 0
              ? "Выберите товар для спорной позиции — набор проведётся сразу."
              : "Запись появится только после подтверждения."}
          </p>
          <Button
            type="button"
            className="h-11 w-full shrink-0 sm:w-auto md:h-10"
            disabled={!canApply}
            onClick={() => onApply(plan)}
          >
            {isApplying ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Проводим...
              </>
            ) : (
              <>
                <Check className="mr-2 h-4 w-4" />
                Провести
                {plan.operations.length > 0 ? ` (${plan.operations.length})` : ""}
              </>
            )}
          </Button>
        </div>
      )}

      {review.status !== "pending" && (
        <div className="flex flex-col gap-2 border-t px-3 py-3 sm:flex-row sm:items-center sm:justify-between md:px-4">
          <div className="min-w-0 text-xs">
            {review.status === "undone" ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <Undo2 className="h-3.5 w-3.5" />
                Набор отменён, остатки восстановлены
              </span>
            ) : review.appliedCount > 0 ? (
              <span className="inline-flex items-center gap-1 text-green-700">
                <Check className="h-3.5 w-3.5" />
                {`Проведено позиций: ${review.appliedCount}`}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-700">
                <AlertTriangle className="h-3.5 w-3.5" />
                Ни одна позиция не проведена
              </span>
            )}
            {review.answer && (
              <p className="mt-1 break-words text-muted-foreground">{review.answer}</p>
            )}
          </div>
          {undoable && (
            <Button
              type="button"
              variant="outline"
              className="h-11 w-full shrink-0 sm:w-auto md:h-10"
              disabled={isUndoing}
              onClick={() => onUndoBatch(review.batchId!)}
            >
              <Undo2 className="mr-2 h-3.5 w-3.5" />
              {isUndoing ? "Отменяем..." : "Отменить набор"}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
