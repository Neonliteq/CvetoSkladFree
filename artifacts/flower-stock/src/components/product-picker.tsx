import { useState } from "react"
import type { Product } from "@workspace/api-client-react"
import { Check, ChevronsUpDown } from "lucide-react"
import { Command, CommandEmpty, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * Выбор товара с поиском.
 *
 * Раньше товар выбирался из выпадающего списка прокруткой: на проде 95 позиций, и каждый
 * раз приходилось листать. Здесь можно начать набирать — по названию, сорту, цвету или
 * псевдониму: магазин называет товары по-своему («роза красная», «Роза Эквадор Freedom»),
 * и поиск по псевдониму находит их так же, как по названию.
 *
 * Разметка намеренно повторяет прежнюю: на кнопке `role="combobox"`, на вариантах
 * `role="option"` — этого требуют проверки интерфейса и вспомогательные технологии, и
 * ломать это ради нового контрола было бы неверно.
 */
export function ProductPicker({
  products,
  value,
  onChange,
  placeholder = "Выберите товар",
  id,
  /** Только складские товары: в накладной букеты не принимают. */
  onlyStock = false,
  disabled = false,
  ariaLabel,
}: {
  products: Product[] | undefined
  value: number | null | undefined
  onChange: (productId: number) => void
  placeholder?: string
  id?: string
  onlyStock?: boolean
  disabled?: boolean
  ariaLabel?: string
}) {
  const [open, setOpen] = useState(false)
  const list = (products ?? []).filter(
    (product) => !onlyStock || product.productType === "stock",
  )
  const selected = list.find((product) => product.id === Number(value))

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          id={id}
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          disabled={disabled}
          className={cn(
            "flex h-11 w-full items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 md:h-10",
            !selected && "text-muted-foreground",
          )}
        >
          <span className="line-clamp-1 text-left">
            {selected
              ? `${selected.name}${selected.variety ? ` (${selected.variety})` : ""} — ${selected.currentStock} ${selected.unit}`
              : placeholder}
          </span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[var(--radix-popover-trigger-width)] p-0"
        align="start"
        // Список не должен вылезать за экран на телефоне.
        collisionPadding={12}
      >
        <Command
          // Поиск идёт по строке `value`: в неё собраны все способы назвать товар.
          filter={(itemValue, search) => {
            const haystack = itemValue.toLocaleLowerCase("ru")
            const needle = search.trim().toLocaleLowerCase("ru")
            if (!needle) return 1
            return haystack.includes(needle) ? 1 : 0
          }}
        >
          <CommandInput placeholder="Найти товар: название, сорт или псевдоним" />
          <CommandList className="max-h-72">
            <CommandEmpty>Товар не найден</CommandEmpty>
            {list.map((product) => {
              // В строку поиска и в подпись варианта кладём всё, чем магазин называет
              // товар: без псевдонимов поиск «розовая» не нашёл бы «Роза Кения Avalanche».
              const haystack = [
                product.name,
                product.variety,
                product.color,
                ...(product.aliases ?? []),
              ]
                .filter(Boolean)
                .join(" ")
              return (
                <CommandItem
                  key={product.id}
                  value={haystack}
                  onSelect={() => {
                    onChange(product.id)
                    setOpen(false)
                  }}
                  className="items-start gap-2 py-2"
                >
                  <Check
                    className={cn(
                      "mt-0.5 h-4 w-4 shrink-0",
                      product.id === Number(value) ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="flex flex-col">
                    <span>
                      {product.name}
                      {product.variety ? ` (${product.variety})` : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      в наличии: {product.currentStock} {product.unit}
                      {product.purchasePrice > 0 ? ` · закупка ${product.purchasePrice} ₽` : ""}
                    </span>
                  </span>
                </CommandItem>
              )
            })}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
