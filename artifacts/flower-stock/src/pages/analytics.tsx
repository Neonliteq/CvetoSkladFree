import { useState } from "react"
import { useGetMovementAnalytics, useListProducts } from "@workspace/api-client-react"
import { formatCurrency, formatDate, formatDateShort } from "@/lib/utils"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
} from "recharts"
import { Activity, BadgeDollarSign, CircleDollarSign, WalletCards } from "lucide-react"

/** Сколько строк разбора показывать, пока не попросили весь список. */
const BREAKDOWN_PREVIEW = 8

/**
 * Сравнение с прошлым периодом.
 *
 * Без него «47 496 ₽» ничего не говорит: непонятно, это рост или провал.
 * Проценты считаются от прошлого значения, а если его не было — показывается
 * «новых данных нет», а не бесконечность.
 */
function DeltaBadge({
  current,
  previous,
  label,
}: {
  current: number
  previous: number | null | undefined
  label: string
}) {
  if (typeof previous !== "number") return null
  const change = previous !== 0 ? ((current - previous) / previous) * 100 : null
  return (
    <span
      className={`mt-1 inline-flex items-center gap-1 text-xs ${
        change === null
          ? "text-muted-foreground"
          : change >= 0
            ? "text-green-600"
            : "text-destructive"
      }`}
      title={`${label}: прошлый период ${formatCurrency(previous)}`}
    >
      {change === null
        ? "прошлый период пуст"
        : `${change >= 0 ? "+" : "−"}${Math.abs(change).toFixed(0)}% к прошлому периоду`}
    </span>
  )
}

export default function AnalyticsPage() {
  // По умолчанию — неделя: за месяц магазин успевает много раз поменять
  // ассортимент, а неделя рядом с прошлой неделей читается сразу.
  const [dateFrom, setDateFrom] = useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 6)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  })
  const [dateTo, setDateTo] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
  })
  const [type, setType] = useState<string>("all")
  const [productId, setProductId] = useState<string>("all")
  const [category, setCategory] = useState<string>("all")
  // По чему разбирать выбранный вид операций: по категориям или по товарам.
  const [dimension, setDimension] = useState<"category" | "product">("category")
  const [showAllBreakdown, setShowAllBreakdown] = useState(false)
  const { data: products } = useListProducts()
  const categories = Array.from(new Set(products?.map((product) => product.category) ?? []))

  const { data: analytics, isLoading } = useGetMovementAnalytics({
    from: dateFrom || undefined,
    to: dateTo || undefined,
    type: type !== "all" ? type as any : undefined,
    productId: productId !== "all" ? Number(productId) : undefined,
    category: category !== "all" ? category : undefined,
    breakdown: dimension,
  })

  const getTypeLabel = (t: string) => {
    switch (t) {
      case 'receipt': return 'Приход'
      case 'expense': return 'Продажа'
      case 'writeoff': return 'Списание'
      case 'transfer': return 'Перемещение'
      // «Сборка» и «Готовый букет» — те же подписи, что в истории операций:
      // один и тот же тип не должен называться по-разному на двух экранах.
      case 'production_input': return 'Сборка'
      case 'production_output': return 'Готовый букет'
      default: return t
    }
  }

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Аналитика</h1>
        <p className="text-muted-foreground mt-1">Анализ движения товаров и финансовых потоков</p>
      </div>

      <Card className="bg-card">
        <CardContent className="p-4 flex flex-wrap gap-4 items-end">
          <div className="space-y-1">
            <Label htmlFor="dateFrom" className="text-xs">Период с</Label>
            <Input 
              id="dateFrom" 
              type="date" 
              value={dateFrom} 
              onChange={(e) => setDateFrom(e.target.value)} 
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dateTo" className="text-xs">по</Label>
            <Input 
              id="dateTo" 
              type="date" 
              value={dateTo} 
              onChange={(e) => setDateTo(e.target.value)} 
              className="w-40"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Тип операций</Label>
            <Select value={type} onValueChange={setType}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Все операции" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все операции</SelectItem>
                <SelectItem value="receipt">Приход</SelectItem>
                <SelectItem value="expense">Продажа</SelectItem>
                <SelectItem value="writeoff">Списание</SelectItem>
                <SelectItem value="production_input">Сборка (расход)</SelectItem>
                <SelectItem value="production_output">Готовый букет (приход)</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Товар</Label>
            <Select value={productId} onValueChange={setProductId}>
              <SelectTrigger className="w-[220px]">
                <SelectValue placeholder="Все товары" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все товары</SelectItem>
                {products?.map((product) => (
                  <SelectItem key={product.id} value={String(product.id)}>
                    {product.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Категория</Label>
            <Select value={category} onValueChange={setCategory}>
              <SelectTrigger className="w-[180px]">
                <SelectValue placeholder="Все категории" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все категории</SelectItem>
                {categories.map((item) => (
                  <SelectItem key={item} value={item}>{item}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Показывать</Label>
            {/* Вид разбора — те же кнопки, что и в окне операции: выбор виден сразу. */}
            <div className="flex gap-1" role="group" aria-label="Разбор аналитики">
              {[
                { value: "category" as const, label: "По категориям" },
                { value: "product" as const, label: "По товарам" },
              ].map((option) => (
                <Button
                  key={option.value}
                  type="button"
                  variant={dimension === option.value ? "default" : "outline"}
                  className="h-11 px-3 md:h-10"
                  aria-pressed={dimension === option.value}
                  onClick={() => {
                    setDimension(option.value)
                    setShowAllBreakdown(false)
                  }}
                >
                  {option.label}
                </Button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
      <p className="-mt-4 text-xs text-muted-foreground">
        Дни считаются по календарю магазина: операция после полуночи остаётся в своих сутках.
      </p>

      {isLoading ? (
        <div className="h-64 flex items-center justify-center text-muted-foreground">Загрузка аналитики...</div>
      ) : !analytics ? (
        <div className="h-64 flex items-center justify-center text-muted-foreground">Нет данных</div>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Выручка</CardTitle>
                <CircleDollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(analytics.totalRevenue)}</div>
                <p className="mt-1 text-xs text-muted-foreground">По фактическим ценам продаж</p>
                <DeltaBadge
                  current={analytics.totalRevenue}
                  previous={analytics.previous?.totalRevenue}
                  label="Выручка"
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Себестоимость</CardTitle>
                <WalletCards className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(analytics.totalCost)}</div>
                <p className="mt-1 text-xs text-muted-foreground">По списанным FIFO-партиям</p>
                <DeltaBadge
                  current={analytics.totalCost}
                  previous={analytics.previous?.totalCost}
                  label="Себестоимость"
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Валовая прибыль</CardTitle>
                <BadgeDollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatCurrency(analytics.grossProfit)}</div>
                <p className="mt-1 text-xs text-muted-foreground">Выручка минус себестоимость</p>
                <DeltaBadge
                  current={analytics.grossProfit}
                  previous={analytics.previous?.grossProfit}
                  label="Валовая прибыль"
                />
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Продажи</CardTitle>
                <Activity className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {analytics.byType.find((item) => item.type === "expense")?.operations ?? 0}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {analytics.byType.find((item) => item.type === "expense")?.quantity ?? 0} ед. за период
                </p>
                <DeltaBadge
                  current={analytics.totalRevenue}
                  previous={analytics.previous?.totalRevenue}
                  label="Выручка"
                />
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Динамика (Сумма)</CardTitle>
                <CardDescription>
                  По дням: выручка, закупки и списания отдельными линиями — «всего» смешивало
                  приход с продажей и о деньгах не говорило
                </CardDescription>
              </CardHeader>
              <CardContent className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={analytics.timeline}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(val) => formatDateShort(val)}
                      stroke="var(--muted-foreground)"
                      fontSize={12}
                      tickLine={false}
                    />
                    <YAxis
                      stroke="var(--muted-foreground)"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(val) => `₽${val}`}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
                      labelFormatter={(val) => formatDate(val as string)}
                      formatter={(val: number, name: string) => [formatCurrency(val), name]}
                    />
                    {/* Цвета из палитры темы: три линии должны читаться как три
                        разных потока, а подписи — объяснять, какая где. */}
                    <Legend />
                    <Line
                      type="monotone"
                      dataKey="soldValue"
                      name="Выручка"
                      stroke="var(--color-chart-1)"
                      strokeWidth={3}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="receiptValue"
                      name="Закупки"
                      stroke="var(--color-chart-2)"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="writeoffValue"
                      name="Списания"
                      stroke="var(--color-chart-3)"
                      strokeWidth={2}
                      strokeDasharray="4 4"
                      dot={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Динамика (Количество)</CardTitle>
                <CardDescription>
                  Продано и принято по дням: приход и продажа — разные потоки, вместе они
                  давали число, по которому ничего не видно
                </CardDescription>
              </CardHeader>
              <CardContent className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={analytics.timeline}>
                    <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
                    <XAxis
                      dataKey="date"
                      tickFormatter={(val) => formatDateShort(val)}
                      stroke="var(--muted-foreground)"
                      fontSize={12}
                      tickLine={false}
                    />
                    <YAxis
                      stroke="var(--muted-foreground)"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: 'var(--card)', borderColor: 'var(--border)' }}
                      labelFormatter={(val) => formatDate(val as string)}
                      formatter={(val: number, name: string) => [val, name]}
                    />
                    <Legend />
                    <Bar dataKey="soldQuantity" name="Продано" fill="var(--color-chart-1)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="receiptQuantity" name="Принято" fill="var(--color-chart-2)" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="writeoffQuantity" name="Списано" fill="var(--color-chart-3)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>Структура по типам</CardTitle>
                <CardDescription>Распределение объема операций</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {analytics.byType.map((bt, i) => (
                    <div key={i} className="flex items-center justify-between">
                      <div className="flex flex-col">
                        <span className="font-medium text-sm">{getTypeLabel(bt.type)}</span>
                        <span className="text-xs text-muted-foreground">{bt.operations} операций</span>
                      </div>
                      <div className="flex flex-col items-end">
                        <span className="font-bold">{formatCurrency(bt.value)}</span>
                        <span className="text-xs text-muted-foreground">{bt.quantity} ед.</span>
                      </div>
                    </div>
                  ))}
                  {analytics.byType.length === 0 && (
                    <div className="text-sm text-muted-foreground">Нет данных по типам</div>
                  )}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Топ товаров</CardTitle>
                <CardDescription>Что продавалось больше всего за период</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  {analytics.topProducts.map((p, i) => (
                    <div key={p.productId} className="flex items-center justify-between">
                      <div className="flex flex-col flex-1 truncate pr-4">
                        <span className="font-medium text-sm truncate">{i + 1}. {p.productName}</span>
                        <span className="text-xs text-muted-foreground">{p.category}</span>
                      </div>
                      <div className="flex flex-col items-end shrink-0">
                        <span className="font-bold">{p.soldQuantity} ед. продано</span>
                        <span className="text-xs text-muted-foreground">
                          выручка {formatCurrency(p.revenue)}
                        </span>
                      </div>
                    </div>
                  ))}
                  {analytics.topProducts.length === 0 && (
                    <div className="text-sm text-muted-foreground">
                      За период ничего не продано — в топе пусто.
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          {/*
            Разбор по категориям или товарам.

            Колонки зависят от вида операций: выручка и прибыль есть только у
            продаж, себестоимость — ещё и у списаний. Ноль вместо прочерка читался
            бы как «продали на ноль рублей», поэтому сервер отдаёт null.
          */}
          <Card>
            <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
              <div>
                <CardTitle>
                  Разбор {dimension === "category" ? "по категориям" : "по товарам"}
                </CardTitle>
                <CardDescription>
                  {type === "all"
                    ? "Все виды операций за период: количество, стоимость, выручка и себестоимость"
                    : `Вид операций: ${getTypeLabel(type)}`}
                </CardDescription>
              </div>
              {(analytics.breakdown?.rows.length ?? 0) > BREAKDOWN_PREVIEW && (
                <Button
                  variant="outline"
                  className="h-11 shrink-0 md:h-10"
                  onClick={() => setShowAllBreakdown((current) => !current)}
                >
                  {showAllBreakdown
                    ? "Свернуть"
                    : `Показать все (${analytics.breakdown?.rows.length})`}
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {!analytics.breakdown?.rows.length ? (
                <div className="py-6 text-center text-sm text-muted-foreground">
                  За период операций нет. Измените даты или фильтры.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{dimension === "category" ? "Категория" : "Товар"}</TableHead>
                        <TableHead className="text-right">Операций</TableHead>
                        <TableHead className="text-right">Количество</TableHead>
                        <TableHead className="text-right">Стоимость</TableHead>
                        <TableHead className="text-right">Выручка</TableHead>
                        <TableHead className="text-right">Себестоимость</TableHead>
                        <TableHead className="text-right">Прибыль</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(showAllBreakdown
                        ? analytics.breakdown.rows
                        : analytics.breakdown.rows.slice(0, BREAKDOWN_PREVIEW)
                      ).map((row) => (
                        <TableRow key={row.name}>
                          <TableCell className="font-medium">{row.name}</TableCell>
                          <TableCell className="text-right text-sm text-muted-foreground">
                            {row.operations}
                          </TableCell>
                          <TableCell className="text-right">{row.quantity}</TableCell>
                          <TableCell className="text-right">{formatCurrency(row.value)}</TableCell>
                          <TableCell className="text-right">
                            {row.revenue === null || row.revenue === undefined
                              ? "—"
                              : formatCurrency(row.revenue)}
                          </TableCell>
                          <TableCell className="text-right">
                            {row.cost === null || row.cost === undefined
                              ? "—"
                              : formatCurrency(row.cost)}
                          </TableCell>
                          <TableCell
                            className={`text-right font-medium ${
                              (row.profit ?? 0) < 0 ? "text-destructive" : ""
                            }`}
                          >
                            {row.profit === null || row.profit === undefined
                              ? "—"
                              : formatCurrency(row.profit)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
