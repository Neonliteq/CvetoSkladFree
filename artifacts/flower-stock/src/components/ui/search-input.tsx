import type { ChangeEvent } from "react"
import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

type SearchInputProps = {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  /** Подпись для программ чтения с экрана: у полей разное назначение. */
  label: string
  className?: string
}

/**
 * Поле поиска с крестиком для сброса.
 *
 * Крестик нужен прежде всего на телефоне: стереть длинный запрос клавиатурой
 * неудобно, а кнопка «очистить» появляется только когда есть что стирать и по
 * размеру не меньше остальных элементов управления (44 px).
 */
export function SearchInput({
  value,
  onChange,
  placeholder,
  label,
  className,
}: SearchInputProps) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>) => onChange(event.target.value)

  return (
    <div className={cn("relative w-full", className)}>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        aria-label={label}
        // Отступ справа оставляем под крестик, иначе текст уходит под него.
        className="h-11 bg-card pl-9 pr-12 md:h-10"
      />
      {value.length > 0 && (
        <button
          type="button"
          // Кнопка занимает всю высоту поля: на телефоне попасть в маленький
          // крестик трудно.
          className="absolute right-0 top-0 flex h-11 w-11 items-center justify-center rounded-r-md text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 md:h-10 md:w-10"
          aria-label="Очистить поиск"
          onClick={() => onChange("")}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}
