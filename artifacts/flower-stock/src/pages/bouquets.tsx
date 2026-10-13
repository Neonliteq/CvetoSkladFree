import { useMemo, useState } from "react"
import { Bouquet, useListBouquets } from "@workspace/api-client-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table"
import { Edit2, History, PackagePlus } from "lucide-react"
import { formatCurrency, formatDate } from "@/lib/utils"
import { CreateBouquetDialog } from "./create-bouquet-dialog"
import { EditBouquetDialog } from "./edit-bouquet-dialog"
import { ProduceBouquetDialog } from "./produce-bouquet-dialog"
import { BouquetProductionDialog } from "./bouquet-production-dialog"
import { SortableTableHead } from "@/components/sortable-table-head"
import { ResizableTable } from "@/components/ui/resizable-table"
import { BouquetsMobileList } from "./bouquets-mobile-list"

/**
 * Ширина таблицы букетов на большом экране.
 *
 * Своя, отдельная от склада: у букетов другой набор колонок, и общая ширина
 * заставляла бы подгонять обе таблицы друг под друга.
 */
const TABLE_MIN_WIDTH = 760
const TABLE_DEFAULT_WIDTH = 1180
const TABLE_WIDTH_KEY = "florasklad:table-width:bouquets"

type BouquetSortKey = "name" | "category" | "components" | "stock" | "cost" | "markup" | "sale"

export default function BouquetsPage() {
  const { data: bouquets, isLoading } = useListBouquets()
  
  const [editingBouquet, setEditingBouquet] = useState<Bouquet | null>(null)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)

  const [producingBouquet, setProducingBouquet] = useState<Bouquet | null>(null)
  const [isProduceDialogOpen, setIsProduceDialogOpen] = useState(false)
  const [historyBouquet, setHistoryBouquet] = useState<Bouquet | null>(null)
  const [isHistoryDialogOpen, setIsHistoryDialogOpen] = useState(false)
  // Фильтр по категории: в магазине букетов становится много, и искать нужный
  // в общем списке неудобно.
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  const [sort, setSort] = useState<{ key: BouquetSortKey; direction: "asc" | "desc" }>({
    key: "name",
    direction: "asc",
  })
  const categories = useMemo(
    () => [...new Set((bouquets ?? []).map((bouquet) => bouquet.category || "Букеты"))].sort(
      (left, right) => left.localeCompare(right, "ru"),
    ),
    [bouquets],
  )
  const visibleBouquets = useMemo(
    () =>
      (bouquets ?? []).filter(
        (bouquet) => categoryFilter === "all" || (bouquet.category || "Букеты") === categoryFilter,
      ),
    [bouquets, categoryFilter],
  )
  const sortedBouquets = useMemo(() => {
    const value = (bouquet: Bouquet) => {
      switch (sort.key) {
        case "name": return bouquet.name
        case "category": return bouquet.category || "Букеты"
        case "components": return bouquet.components.map((component) => component.productName).join(" ")
        case "stock": return bouquet.currentStock
        case "cost": return bouquet.calculatedCost
        case "markup": return bouquet.markupPercent
        case "sale": return bouquet.salePrice
      }
    }
    return [...visibleBouquets].sort((a, b) => {
      const aValue = value(a)
      const bValue = value(b)
      const result = typeof aValue === "number"
        ? aValue - Number(bValue)
        : aValue.localeCompare(String(bValue), "ru", { sensitivity: "base" })
      return sort.direction === "asc" ? result : -result
    })
  }, [visibleBouquets, sort])
  const toggleSort = (key: BouquetSortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }))
  }

  const openEdit = (bouquet: Bouquet) => {
    setEditingBouquet(bouquet)
    setIsEditDialogOpen(true)
  }

  const openProduce = (bouquet: Bouquet) => {
    setProducingBouquet(bouquet)
    setIsProduceDialogOpen(true)
  }

  const openHistory = (bouquet: Bouquet) => {
    setHistoryBouquet(bouquet)
    setIsHistoryDialogOpen(true)
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">
            Готовые букеты
          </h1>
          <p className="text-muted-foreground mt-1">Рецептуры и производство букетов</p>
        </div>
        <CreateBouquetDialog />
      </div>

      {/* Фильтр по категориям появляется, когда категорий больше одной: иначе
          ряд кнопок занимал бы место без пользы. */}
      {categories.length > 1 && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Категория букетов">
          <Button
            type="button"
            variant={categoryFilter === "all" ? "default" : "outline"}
            className="h-11 px-3 md:h-10"
            aria-pressed={categoryFilter === "all"}
            onClick={() => setCategoryFilter("all")}
          >
            Все категории
          </Button>
          {categories.map((item) => (
            <Button
              key={item}
              type="button"
              variant={categoryFilter === item ? "default" : "outline"}
              className="h-11 px-3 md:h-10"
              aria-pressed={categoryFilter === item}
              onClick={() => setCategoryFilter(item)}
            >
              {item}
            </Button>
          ))}
        </div>
      )}

      {isLoading ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground shadow-sm">
          Загрузка...
        </div>
      ) : bouquets?.length === 0 ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground shadow-sm">
          Букеты не найдены.
        </div>
      ) : sortedBouquets.length === 0 ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground shadow-sm">
          В категории «{categoryFilter}» букетов нет. Выберите другую или «Все категории».
        </div>
      ) : (
        <>
          <div className="md:hidden">
            <BouquetsMobileList
              bouquets={sortedBouquets}
              onProduce={openProduce}
              onEdit={openEdit}
              onHistory={openHistory}
            />
          </div>

          <div className="hidden md:block">
            <ResizableTable
              storageKey={TABLE_WIDTH_KEY}
              minWidth={TABLE_MIN_WIDTH}
              defaultWidth={TABLE_DEFAULT_WIDTH}
            >
              {(width) => (
            <Table
              className="w-auto table-fixed"
              style={{ width: `${width}px`, minWidth: `${TABLE_MIN_WIDTH}px` }}
            >
          <TableHeader>
            <TableRow className="bg-muted/50">
              <SortableTableHead label="Название" active={sort.key === "name"} direction={sort.direction} onClick={() => toggleSort("name")} className="w-[13%]" />
              {/* Категория рядом с названием: по ней букеты ищут. */}
              <SortableTableHead label="Категория" active={sort.key === "category"} direction={sort.direction} onClick={() => toggleSort("category")} className="w-[8%]" />
              <SortableTableHead label="Состав" active={sort.key === "components"} direction={sort.direction} onClick={() => toggleSort("components")} className="w-[22%]" />
              {/* «Собрано» вместо «остатка»: букеты не закупают, а собирают, и
                  число показывает, сколько их сейчас лежит на складе. */}
              <SortableTableHead label="Собрано" active={sort.key === "stock"} direction={sort.direction} onClick={() => toggleSort("stock")} className="w-[7%] text-right" />
              <SortableTableHead label="Себестоимость" active={sort.key === "cost"} direction={sort.direction} onClick={() => toggleSort("cost")} className="w-[10%] text-right" />
              <SortableTableHead label="Наценка" active={sort.key === "markup"} direction={sort.direction} onClick={() => toggleSort("markup")} className="w-[7%] text-right" />
              <SortableTableHead label="Цена продажи" active={sort.key === "sale"} direction={sort.direction} onClick={() => toggleSort("sale")} className="w-[9%] text-right" />
              <TableHead className="w-[13%]">Последняя сборка</TableHead>
              <TableHead className="w-[11%]"></TableHead>
              {/* Полоса для растягивания: она должна попадать внутрь окна, иначе
                  её перекрывает соседний блок страницы. */}
              <TableHead className="w-[14px] p-0" aria-hidden />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedBouquets.map((bouquet) => (
                <TableRow key={bouquet.id} className="group hover:bg-muted/30">
                  <TableCell className="font-medium">
                    <span className="text-base">{bouquet.name}</span>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="bg-background font-normal">
                      {bouquet.category || "Букеты"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {/* Состав — блоком: четыре бейджа в строку задавали таблице
                        минимальную ширину больше её собственной, и растягивание
                        переставало работать. */}
                    <div className="flex flex-col items-start gap-1">
                      {bouquet.components.length === 0 ? (
                        <span className="text-xs text-muted-foreground">Нет состава</span>
                      ) : (
                        bouquet.components.map((c, i) => (
                          <Badge key={i} variant="outline" className="text-xs bg-background font-normal">
                            {c.productName} × {c.quantity} {c.unit}
                          </Badge>
                        ))
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="font-bold text-lg">{bouquet.currentStock}</span>
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {formatCurrency(bouquet.calculatedCost)}
                  </TableCell>
                  <TableCell className="text-right">
                    {bouquet.markupPercent}%
                  </TableCell>
                  <TableCell className="text-right font-bold text-primary">
                    {formatCurrency(bouquet.salePrice)}
                  </TableCell>
                  <TableCell className="text-sm">
                    {bouquet.lastProduction ? (
                      <div className="flex flex-col">
                        <span>{formatDate(bouquet.lastProduction.createdAt)}</span>
                        {/* Фактическая цена последней сборки: рецепт — шаблон, а
                            в работе цену часто ставят по факту. */}
                        <span className="text-xs text-muted-foreground">
                          по {formatCurrency(bouquet.lastProduction.salePrice)} ·{" "}
                          {bouquet.lastProduction.quantity} шт
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">Ещё не собирали</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* Hover-only actions are unusable on touch, so they stay
                        visible below `lg` and fade in on pointer devices only. */}
                    <div className="flex items-center justify-end gap-1 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 lg:h-9 lg:w-9"
                        onClick={() => openProduce(bouquet)}
                        aria-label={`Собрать ${bouquet.name}`}
                        title="Произвести"
                      >
                        <PackagePlus className="h-4 w-4 text-secondary" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 lg:h-9 lg:w-9"
                        onClick={() => openHistory(bouquet)}
                        aria-label={`История сборок ${bouquet.name}`}
                        title="История сборок"
                      >
                        <History className="h-4 w-4 text-muted-foreground" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-11 w-11 lg:h-9 lg:w-9"
                        onClick={() => openEdit(bouquet)}
                        aria-label={`Редактировать ${bouquet.name}`}
                        title="Редактировать"
                      >
                        <Edit2 className="h-4 w-4 text-muted-foreground" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
          </TableBody>
        </Table>
              )}
            </ResizableTable>
          </div>
        </>
      )}

      <EditBouquetDialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen} bouquet={editingBouquet} />
      <ProduceBouquetDialog open={isProduceDialogOpen} onOpenChange={setIsProduceDialogOpen} bouquet={producingBouquet} />
      <BouquetProductionDialog open={isHistoryDialogOpen} onOpenChange={setIsHistoryDialogOpen} bouquet={historyBouquet} />
    </div>
  )
}
