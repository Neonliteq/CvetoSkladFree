import { useEffect } from "react"
import { useTheme } from "next-themes"
import { Monitor, Moon, Sun } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Ключ хранилища — тот же, что читает скрипт в `index.html` до загрузки приложения. */
export const THEME_STORAGE_KEY = "florasklad-theme"

type Choice = "system" | "light" | "dark"

const ORDER: Choice[] = ["system", "light", "dark"]

const LABELS: Record<Choice, string> = {
  system: "Как в системе",
  light: "Светлая",
  dark: "Тёмная",
}

const ICONS = { system: Monitor, light: Sun, dark: Moon } as const

/**
 * Переключатель темы: системная → светлая → тёмная.
 *
 * Три состояния, а не два: по умолчанию склад живёт «как в системе», и это разумно —
 * планшет в зале и телефон владельца могут быть настроены по-разному. Кому нужно
 * закрепить тему, тот проходит по кругу ещё раз.
 *
 * Стоит в нижнем блоке рядом с учётной записью: это личная настройка устройства, а не
 * рабочий раздел, и в общем меню она мешала бы.
 */
export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme()
  const current: Choice = theme === "light" || theme === "dark" ? theme : "system"
  const Icon = ICONS[current]

  // Цвет адресной строки на телефоне. Без этого тёмная тема открывается с алой
  // полосой сверху — она остаётся от светлой.
  useEffect(() => {
    if (typeof document === "undefined") return
    const meta = document.querySelector('meta[name="theme-color"]')
    if (!meta) return
    // Через кадр, а не сразу: класс темы ставит эффект провайдера, и эффект ребёнка
    // выполняется раньше родительского — немедленное чтение вернуло бы палитру ещё
    // предыдущей темы, и полоса оставалась бы тёмной после переключения на светлую.
    const frame = requestAnimationFrame(() => {
      const sidebar = getComputedStyle(document.documentElement)
        .getPropertyValue("--sidebar")
        .trim()
      meta.setAttribute(
        "content",
        hslToHex(sidebar) ?? (resolvedTheme === "dark" ? "#191116" : "#5c1f36"),
      )
    })
    return () => cancelAnimationFrame(frame)
  }, [resolvedTheme])

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={() => {
        const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]
        setTheme(next)
      }}
      // Подпись говорит, что произойдёт при нажатии, а не что включено сейчас:
      // иначе на вопрос «почему темно» кнопка отвечает «тёмная» и непонятно, что делать.
      aria-label={`Тема: ${LABELS[current]}. Переключить на «${LABELS[ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]]}»`}
      title={`Тема: ${LABELS[current]}`}
      className="h-11 w-full justify-start gap-2 px-3 text-sm text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-foreground md:h-9"
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span>{LABELS[current]}</span>
    </Button>
  )
}

/**
 * Переводит токен темы в hex.
 *
 * Токены записаны как `335 20% 8%` (HSL без обёртки), а `theme-color` ждёт
 * шестнадцатеричный цвет. Читаем из CSS, а не дублируем значения: поменяют палитру —
 * полоса на телефоне поменяется вместе с ней.
 */
function hslToHex(value: string): string | null {
  const match = /^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/u.exec(value)
  if (!match) return null
  const h = Number(match[1]) / 360
  const s = Number(match[2]) / 100
  const l = Number(match[3]) / 100
  if (s === 0) {
    const channel = Math.round(l * 255)
    return `#${[channel, channel, channel].map((part) => part.toString(16).padStart(2, "0")).join("")}`
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    let value = t
    if (value < 0) value += 1
    if (value > 1) value -= 1
    if (value < 1 / 6) return p + (q - p) * 6 * value
    if (value < 1 / 2) return q
    if (value < 2 / 3) return p + (q - p) * (2 / 3 - value) * 6
    return p
  }
  return `#${[h + 1 / 3, h, h - 1 / 3]
    .map((t) => Math.round(channel(t) * 255).toString(16).padStart(2, "0"))
    .join("")}`
}
