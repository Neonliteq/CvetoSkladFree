import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react"

type Props = {
  /** Ключ в localStorage: у каждой таблицы своя запоминаемая ширина. */
  storageKey: string
  minWidth: number
  defaultWidth: number
  /** Таблица получает ширину и сама решает, как её применить. */
  children: (width: number) => ReactNode
}

/**
 * Обёртка таблицы, которую можно растянуть за правый край.
 *
 * Не набор фиксированных вариантов, а растягивание: тянуть за правый край
 * удобнее, чем угадывать подходящий пресет. Ширина хранится в пикселях в
 * localStorage под своим ключом, поэтому склад, букеты и операции
 * запоминаются по отдельности.
 *
 * Слушатели вешаются на window на время перетаскивания: так курсор не
 * «отклеивается» от ручки, если увести мышь далеко. Ширина пишется в хранилище
 * по окончании, чтобы не дёргать его на каждом движении.
 */
export function ResizableTable({
  storageKey,
  minWidth,
  defaultWidth,
  children,
}: Props) {
  const readStoredWidth = (): number => {
    if (typeof window === "undefined") return defaultWidth
    try {
      const stored = Number(window.localStorage.getItem(storageKey))
      return Number.isFinite(stored) && stored >= minWidth ? stored : defaultWidth
    } catch {
      return defaultWidth
    }
  }

  const [width, setWidth] = useState<number>(readStoredWidth)
  const [isResizing, setIsResizing] = useState(false)
  const [maxWidth, setMaxWidth] = useState<number | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)

  /**
   * Предел ширины — место до правого края содержимого страницы.
   *
   * Без него широкая таблица уходит под боковое меню: ручка перестаёт получать
   * нажатие, а последняя колонка обрезается. Меряем по свободному месту в
   * родителе, а не по `100vw`: у страницы есть свои отступы, и они разные на
   * телефоне и на мониторе.
   */
  useEffect(() => {
    const area = areaRef.current?.parentElement
    if (!area) return
    const measure = () => {
      const available = area.clientWidth
      if (available > 0) setMaxWidth(Math.max(minWidth, available - 8))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(area)
    return () => observer.disconnect()
  }, [minWidth])

  const limit = maxWidth ?? Number.POSITIVE_INFINITY
  const shownWidth = Math.min(width, limit)

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = shownWidth
    setIsResizing(true)

    const onMove = (moveEvent: PointerEvent) => {
      setWidth(Math.min(limit, Math.max(minWidth, startWidth + (moveEvent.clientX - startX))))
    }
    const onUp = () => {
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      setIsResizing(false)
      setWidth((current) => {
        try {
          window.localStorage.setItem(storageKey, String(current))
        } catch {
          // Ширина остаётся в силе до перезагрузки.
        }
        return current
      })
    }
    window.addEventListener("pointermove", onMove)
    window.addEventListener("pointerup", onUp)
  }

  const resetWidth = () => {
    setWidth(defaultWidth)
    try {
      window.localStorage.setItem(storageKey, String(defaultWidth))
    } catch {
      // Не критично.
    }
  }

  return (
    // Обёртка шириной ровно с таблицу: полоса захвата стоит на её правом краю и
    // визуально едет вместе с шириной. Сама полоса лежит ВНЕ области прокрутки:
    // внутри неё она перекрывается содержимым таблицы, и нажатие до ручки не
    // доходит.
    <div ref={areaRef} className="relative w-fit max-w-full">
      <div
        className={`overflow-x-auto rounded-xl border bg-card shadow-sm ${
          isResizing ? "select-none" : ""
        }`}
      >
        <div className="w-fit">{children(shownWidth)}</div>
      </div>
      {/* Полоса на правом краю таблицы: подсвечивается при наведении и при
          перетаскивании, поэтому видно, за что тянуть. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Изменить ширину таблицы"
        title={`Потяните за край, чтобы изменить ширину (сейчас ${Math.round(shownWidth)} px). Двойной щелчок — обычная ширина.`}
        onPointerDown={startResize}
        onDoubleClick={resetWidth}
        className={`absolute inset-y-0 -right-1 z-30 w-2 cursor-ew-resize touch-none rounded-full transition-colors ${
          isResizing ? "bg-primary/60" : "bg-transparent hover:bg-primary/40"
        }`}
      />
    </div>
  )
}
