import { Fragment, useMemo, useState } from "react"
import {
  Product,
  getGetDashboardQueryKey,
  getListProductsQueryKey,
  listProducts,
  useDeleteProduct,
  useGetDashboard,
  useListProducts,
  useRestoreProduct,
} from "@workspace/api-client-react"
import { Input } from "@/components/ui/input"
import { SearchInput } from "@/components/ui/search-input"
import { Button } from "@/components/ui/button"
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table"
import { Search, Filter, AlertCircle, Archive, ArchiveRestore, Edit2, Trash2, ChevronDown, ChevronRight, Clock, GripVertical } from "lucide-react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { toast } from "sonner"
import { formatCurrency, formatDate } from "@/lib/utils"
import { buildExpiringIndex, expiringLabel, isLowStock } from "@/lib/stock-signals"
import { CreateProductDialog } from "./create-product-dialog"
import { EditProductDialog } from "./edit-product-dialog"
import { CreateMovementDialog } from "./create-movement-dialog"
import { ProductReceiptsPanel } from "./product-receipts-dialog"
import { SortableTableHead } from "@/components/sortable-table-head"
import { ResizableTable } from "@/components/ui/resizable-table"
import { ProductsMobileList } from "./products-mobile-list"

/**
 * Ширина таблицы склада на большом экране.
 *
 * Значение хранится в пикселях и восстанавливается при следующем открытии;
 * растягивание живёт в общем компоненте `ResizableTable`.
 */
const TABLE_MIN_WIDTH = 780
const TABLE_DEFAULT_WIDTH = 1080
const TABLE_WIDTH_KEY = "florasklad:table-width"

type ProductSortKey = "name" | "category" | "stock" | "receipt" | "purchase" | "markup" | "sale"

export default function ProductsPage() {
  const [search, setSearch] = useState("")
  const [lowStockFilter, setLowStockFilter] = useState(false)
  // Архив: ненужные товары скрыты по умолчанию, но их можно посмотреть и вернуть.
  const [showArchived, setShowArchived] = useState(false)
  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false)
  const [expandedProductId, setExpandedProductId] = useState<number | null>(null)
  const [sort, setSort] = useState<{ key: ProductSortKey; direction: "asc" | "desc" }>({
    key: "name",
    direction: "asc",
  })
  const queryClient = useQueryClient()
  
  const { data: products, isLoading } = useListProducts({
    search: search || undefined,
    // В режиме архива фильтр низкого остатка не имеет смысла: товар не в работе.
    lowStock: lowStockFilter && !showArchived ? true : undefined,
    archived: showArchived ? true : undefined,
  })
  // The dashboard already reports which batches are about to go off; the same
  // query feeds the dashboard screen, so React Query serves it from cache.
  const { data: dashboard } = useGetDashboard()
  /**
   * Счётчик для кнопки «Архив».
   *
   * Отдельный запрос только ради числа: иначе пришлось бы тянуть архив вместе
   * с рабочим списком и показывать его в таблице. Ключ совпадает с основным
   * запросом при showArchived, поэтому список из архива берётся из кэша.
   */
  const { data: archivedProducts } = useQuery({
    queryKey: getListProductsQueryKey({ archived: true }),
    queryFn: () => listProducts({ archived: true }),
    enabled: !showArchived,
  })
  const archivedCount = archivedProducts?.length ?? 0
  const expiringByProduct = useMemo(
    () => buildExpiringIndex(dashboard?.expiring),
    [dashboard],
  )

  const stockProducts = products?.filter((product) => product.productType === "stock")
  const sortedProducts = useMemo(() => {
    const items = [...(stockProducts ?? [])]
    const value = (product: Product) => {
      switch (sort.key) {
        case "name": return product.name
        case "category": return product.category
        case "stock": return product.currentStock
        case "receipt": return product.lastReceiptDate ? new Date(product.lastReceiptDate).getTime() : 0
        case "purchase": return product.averagePrice || product.purchasePrice
        case "markup": return product.markupPercent
        case "sale": return product.salePrice
      }
    }
    return items.sort((a, b) => {
      const aValue = value(a)
      const bValue = value(b)
      const result = typeof aValue === "number"
        ? aValue - Number(bValue)
        : aValue.localeCompare(String(bValue), "ru", { sensitivity: "base" })
      return sort.direction === "asc" ? result : -result
    })
  }, [stockProducts, sort])
  const toggleSort = (key: ProductSortKey) => {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === "asc" ? "desc" : "asc",
    }))
  }
  const { mutate: deleteProduct, isPending: isDeleting } = useDeleteProduct({
    mutation: {
      onSuccess: () => {
        toast.success("Товар перенесён в архив", {
          description: "Он скрыт из работы, но вернуть его можно на вкладке «Архив».",
        })
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось убрать товар в архив")
      },
    },
  })
  const { mutate: restore, isPending: isRestoring } = useRestoreProduct({
    mutation: {
      onSuccess: () => {
        toast.success("Товар возвращён из архива")
        queryClient.invalidateQueries({ queryKey: getListProductsQueryKey() })
        queryClient.invalidateQueries({ queryKey: getGetDashboardQueryKey() })
      },
      onError: (error: any) => {
        toast.error(error?.data?.error || "Не удалось вернуть товар из архива")
      },
    },
  })

  const openEdit = (product: Product) => {
    setEditingProduct(product)
    setIsEditDialogOpen(true)
  }

  /**
   * Убирает товар из списка.
   *
   * Удалить товар с историей операций нельзя — сломается аналитика, поэтому
   * сервер переносит его в архив: позиция исчезает из работы, но остаётся в
   * базе вместе со своей историей и может вернуться.
   */
  const removeProduct = (product: Product) => {
    if (
      !window.confirm(
        `Убрать товар «${product.name}» в архив? Он исчезнет из списка, но история операций сохранится, и товар можно будет вернуть.`,
      )
    ) {
      return
    }
    deleteProduct({ id: product.id })
  }

  const restoreProduct = (product: Product) => {
    restore({ id: product.id })
  }

  const toggleProduct = (productId: number) => {
    setExpandedProductId((current) => current === productId ? null : productId)
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-foreground md:text-3xl">Склад</h1>          <p className="text-muted-foreground mt-1">Управление каталогом и остатками</p>
        </div>
        <CreateProductDialog />
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-center">
        <div className="relative flex-1 w-full">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Поиск по названию, сорту, цвету..."
            label="Поиск товара по названию, сорту или цвету"
          />
        </div>
        <Button 
          variant={lowStockFilter && !showArchived ? "default" : "outline"}
          onClick={() => {
            setShowArchived(false)
            setLowStockFilter(!lowStockFilter)
          }}
          className="w-full sm:w-auto shrink-0 h-11 md:h-10"
        >
          <Filter className="mr-2 h-4 w-4" />
          {lowStockFilter && !showArchived ? "Все товары" : "Только низкий остаток"}
        </Button>
        {/* Архив рядом с фильтром, а не в отдельном меню: убрать товар просто,
            а искать потом, куда он делся, — нет. */}
        <Button
          variant={showArchived ? "default" : "outline"}
          onClick={() => setShowArchived(!showArchived)}
          className="w-full sm:w-auto shrink-0 h-11 md:h-10"
        >
          <Archive className="mr-2 h-4 w-4" />
          {showArchived ? "Обычный склад" : "Архив"}
          {!showArchived && archivedCount > 0 && (
            <span className="ml-2 rounded-full bg-muted-foreground/15 px-2 py-0.5 text-xs font-semibold">
              {archivedCount}
            </span>
          )}
        </Button>
      </div>

      {isLoading ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground shadow-sm">
          Загрузка...
        </div>
      ) : stockProducts?.length === 0 ? (
        <div className="rounded-xl border bg-card py-12 text-center text-muted-foreground shadow-sm">
          {showArchived
            ? "В архиве нет товаров."
            : search || lowStockFilter
              ? "Товары не найдены."
              : archivedCount > 0
                ? `Склад пуст. В архиве — ${archivedCount}. Товар можно вернуть кнопкой «Архив».`
                : "Товары не найдены."}
        </div>
      ) : (
        <>
          {/* Phones get cards: the table needs ~950 px and would only be readable
              by scrolling sideways through seven columns. */}
          <div className="md:hidden">
            <ProductsMobileList
              products={sortedProducts}
              expiringByProduct={expiringByProduct}
              isDeleting={isDeleting}
              isRestoring={isRestoring}
              onEdit={openEdit}
              onDelete={removeProduct}
              onRestore={restoreProduct}
            />
          </div>

          <div className="hidden md:block">
            <ResizableTable
              storageKey={TABLE_WIDTH_KEY}
              minWidth={TABLE_MIN_WIDTH}
              defaultWidth={TABLE_DEFAULT_WIDTH}
            >
              {(width) => (
              <Table className="w-auto" style={{ width: `${width}px`, minWidth: `${TABLE_MIN_WIDTH}px` }}>
          <TableHeader>
            <TableRow className="bg-muted/50 [&>th]:px-3">
              <SortableTableHead label="Название" active={sort.key === "name"} direction={sort.direction} onClick={() => toggleSort("name")} className="sticky left-0 z-20 bg-muted" />
              <SortableTableHead label="Категория" active={sort.key === "category"} direction={sort.direction} onClick={() => toggleSort("category")} />
              <SortableTableHead label="Остаток" active={sort.key === "stock"} direction={sort.direction} onClick={() => toggleSort("stock")} className="text-right" />
              <SortableTableHead label={"Последний приход"} active={sort.key === "receipt"} direction={sort.direction} onClick={() => toggleSort("receipt")} />
              <SortableTableHead label={"Ср. закупка"} active={sort.key === "purchase"} direction={sort.direction} onClick={() => toggleSort("purchase")} className="text-right" />
              <SortableTableHead label="Наценка" active={sort.key === "markup"} direction={sort.direction} onClick={() => toggleSort("markup")} className="text-right" />
              <SortableTableHead label={"Цена продажи"} active={sort.key === "sale"} direction={sort.direction} onClick={() => toggleSort("sale")} className="text-right" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedProducts.map((product) => {
                // Товар в архиве не участвует в работе: подсветка низкого
                // остатка и сроков годности для него только путает.
                const isArchived = Boolean(product.archivedAt)
                const low = !isArchived && isLowStock(product)
                const expiring = isArchived ? undefined : expiringByProduct.get(product.id)
                const isExpanded = expandedProductId === product.id
                // A translucent amber tint plus a stripe: visible at a glance,
                // still readable for a whole screen of rows. The open row gets a
                // neutral tint instead, so it reads as "attached" to its panel.
                const rowClass = low
                  ? "bg-amber-500/10 hover:bg-amber-500/15"
                  : isExpanded
                    ? "bg-muted/50 hover:bg-muted/50"
                    : "hover:bg-muted/30"
                // The first cell is sticky and must stay opaque, so the tint is
                // painted with a solid colour instead of the row's transparency.
                const nameCellClass = low
                  ? "bg-amber-50 group-hover:bg-amber-100/70 dark:bg-amber-950/40 dark:group-hover:bg-amber-950/60"
                  : isExpanded
                    ? "bg-muted group-hover:bg-muted"
                    : "bg-card group-hover:bg-muted/30"
                return (
                <Fragment key={product.id}>
                <TableRow
                  className={`group cursor-pointer ${rowClass}`}
                  aria-expanded={isExpanded}
                  tabIndex={0}
                  onClick={() => toggleProduct(product.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault()
                      toggleProduct(product.id)
                    }
                  }}
                >
                  <TableCell className={`sticky left-0 z-10 px-3 font-medium ${nameCellClass}`}>
                    {low && (
                      // Amber stripe: the row stays readable, the eye still catches it.
                      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-amber-500" />
                    )}
                    {/* Accent stripe while the row is open: it links the product
                        row to the receipts panel underneath it. */}
                    {isExpanded && (
                      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-primary" />
                    )}
                    <div className="flex items-start gap-2">
                      {/* The chevron sits in a circle: with many rows on screen a
                          bare grey arrow was too easy to miss. */}
                      <span
                        aria-hidden
                        className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors ${
                          isExpanded
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-muted-foreground group-hover:bg-muted-foreground/20"
                        }`}
                      >
                        {isExpanded ? (
                          <ChevronDown className="h-3.5 w-3.5" />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5" />
                        )}
                      </span>
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className={isArchived ? "text-muted-foreground" : undefined}>
                            {product.name}
                          </span>
                          {low && (
                            <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                          )}
                          {isArchived && (
                            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
                              в архиве
                            </span>
                          )}
                        </div>
                        {/* Sort and colour used to hold a column each; stacked under
                            the name they stay visible without widening the table. */}
                        {(product.variety || product.color) && (
                          <div className="text-xs font-normal text-muted-foreground">
                            {[product.variety, product.color].filter(Boolean).join(" · ")}
                          </div>
                        )}
                      </div>
                      {/* Действия перенесены влево, к названию: справа их приходилось
                          искать взглядом через всю строку. */}
                      <div
                        className="ml-1 flex shrink-0 items-center"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Редактировать ${product.name}`}
                          onClick={() => openEdit(product)}
                        >
                          <Edit2 className="h-4 w-4 text-muted-foreground" />
                        </Button>
                        {/* В архиве корзины нет: убрать товар из архива нельзя,
                            зато можно вернуть его в работу. */}
                        {isArchived ? (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Вернуть из архива ${product.name}`}
                            title="Вернуть из архива"
                            disabled={isRestoring}
                            onClick={() => restoreProduct(product)}
                          >
                            <ArchiveRestore className="h-4 w-4 text-primary" />
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`Убрать в архив ${product.name}`}
                            title="Убрать в архив"
                            disabled={isDeleting}
                            onClick={() => removeProduct(product)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="px-3">
                    <span className="text-sm">{product.category}</span>
                  </TableCell>
                  <TableCell className="px-3 text-right">
                    {/* Compact by design: stock and minimum share one line, and the
                        expiry note is a small icon instead of a full-width badge. */}
                    <div className="flex flex-col items-end gap-0.5">
                      <span className="whitespace-nowrap text-sm">
                        <span className={`font-bold ${low ? "text-destructive" : ""}`}>
                          {product.currentStock}
                        </span>
                        <span className="text-muted-foreground">
                          {" "}
                          из {product.minimumStock || product.currentStock} {product.unit}
                        </span>
                      </span>
                      {expiring && (
                        <span
                          className="inline-flex items-center gap-1 whitespace-nowrap text-xs font-medium text-red-600 dark:text-red-400"
                          title={`Партия истекает ${formatDate(expiring.expiresAt)} — ${expiringLabel(expiring.daysLeft)}`}
                        >
                          <Clock className="h-3 w-3" />
                          {expiring.daysLeft <= 0 ? "срок истёк" : `${expiring.daysLeft} дн.`}
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3">
                     {product.lastReceiptDate ? formatDate(product.lastReceiptDate) : "Нет приходов"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 text-right font-medium">
                    {formatCurrency(product.averagePrice || product.purchasePrice)}
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 text-right">
                    {product.markupPercent}%
                  </TableCell>
                  <TableCell className="whitespace-nowrap px-3 text-right font-bold text-primary">
                    {formatCurrency(product.salePrice)}
                  </TableCell>

                </TableRow>
                 {isExpanded && (
                   <TableRow className="bg-muted/20 hover:bg-muted/20">
                     <TableCell colSpan={8} className="p-3 sm:p-5">
                       <ProductReceiptsPanel product={product} />
                     </TableCell>
                   </TableRow>
                 )}
                 </Fragment>
                )
              })}
          </TableBody>
        </Table>
              )}
            </ResizableTable>
          </div>
        </>
      )}
      <EditProductDialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen} product={editingProduct} />
    </div>
  )
}
