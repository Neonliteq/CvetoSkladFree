import { Card, CardContent } from "@/components/ui/card"

/**
 * Карточка показателя: подпись капсом, крупное число, пояснение и иконка.
 *
 * Одна на сводку и на аналитику. Раньше каждая страница задавала свои размеры и веса, и
 * одинаковые по смыслу числа выглядели по-разному: где-то 24px жирным, где-то 30px, с
 * разделителями разрядов и без.
 *
 * Числа — `tabular-nums`: без этого соседние карточки «пляшут», когда значение меняется с
 * 1 089 на 999.
 */
export function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone = "default",
  footer,
}: {
  label: string
  value: string | number
  hint?: string
  icon: React.ElementType
  /** Тон задаёт цвет числа и иконки: обычный, предупреждение, тревога. */
  tone?: "default" | "danger" | "warning" | "success"
  /** Строка под пояснением: сравнение с прошлым периодом, кнопка и т. п. */
  footer?: React.ReactNode
}) {
  const toneClass = {
    default: "",
    danger: "text-destructive",
    warning: "text-orange-600 dark:text-orange-400",
    success: "text-green-700 dark:text-green-400",
  }[tone]
  const iconClass = tone === "default" ? "text-muted-foreground" : toneClass

  return (
    <Card className="border-border/70">
      <CardContent className="flex items-start justify-between gap-3 p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {label}
          </p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums tracking-tight ${toneClass}`}>
            {value}
          </p>
          {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
          {footer && <div className="mt-2">{footer}</div>}
        </div>
        <Icon className={`h-4 w-4 shrink-0 ${iconClass}`} />
      </CardContent>
    </Card>
  )
}
