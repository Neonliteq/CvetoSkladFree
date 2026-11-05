import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

/**
 * Статусы интерфейса в одном месте.
 *
 * До этого «не в статистике» было задано своими классами в трёх местах (история операций,
 * мобильный список, детали операции), а просрочка и дефицит — ещё и по-разному. Оттенки
 * расходились: где-то янтарный, где-то оранжевый, где-то `destructive`.
 *
 * Тона называют смысл, а не цвет: `ok`, `soon`, `expired`, `excluded`, `neutral`.
 * Контраст каждого проверяется замером в обеих темах (`check-theme-ui.mjs`).
 */
export type StatusTone = "ok" | "soon" | "expired" | "excluded" | "neutral"

/**
 * Классы по тону: рамка, фон и текст вместе.
 *
 * Прозрачный фон (…/10) обязателен: на плотной таблице заливка в полный цвет перекрывает
 * соседние строки. Текст — тёмный в светлой теме и светлый в тёмной, поэтому у каждого тона
 * два класса.
 */
export const STATUS_TONE_CLASS: Record<StatusTone, string> = {
  ok: "border-green-600/40 bg-green-600/10 text-green-800 dark:border-green-400/40 dark:bg-green-400/10 dark:text-green-300",
  soon: "border-orange-600/40 bg-orange-600/10 text-orange-800 dark:border-orange-400/40 dark:bg-orange-400/10 dark:text-orange-300",
  expired:
    "border-destructive/40 bg-destructive/10 text-destructive dark:border-red-400/40 dark:bg-red-400/10 dark:text-red-300",
  excluded:
    "border-amber-600/40 bg-amber-500/10 text-amber-800 dark:border-amber-400/40 dark:bg-amber-400/10 dark:text-amber-300",
  neutral: "border-border bg-muted/60 text-muted-foreground",
}

/**
 * Метка статуса. Одна на весь интерфейс: бейджи статусов должны выглядеть одинаково,
 * где бы они ни стояли.
 */
export function StatusBadge({
  tone,
  children,
  className,
  title,
}: {
  tone: StatusTone
  children: React.ReactNode
  className?: string
  title?: string
}) {
  return (
    <Badge
      variant="outline"
      title={title}
      className={cn("font-normal", STATUS_TONE_CLASS[tone], className)}
    >
      {children}
    </Badge>
  )
}

/** Пояснение статуса в виде блока — для мест, где бейджа мало (детали операции). */
export function StatusNote({
  tone,
  children,
  className,
}: {
  tone: StatusTone
  children: React.ReactNode
  className?: string
}) {
  return (
    <p className={cn("rounded-md border px-2 py-1.5 text-xs", STATUS_TONE_CLASS[tone], className)}>
      {children}
    </p>
  )
}
