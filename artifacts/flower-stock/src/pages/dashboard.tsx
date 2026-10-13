import { useGetDashboard } from "@workspace/api-client-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { formatCurrency, formatDateTime } from "@/lib/utils"
import { AlertCircle, Package, TrendingDown, Clock, Flower2 } from "lucide-react"

export default function DashboardPage() {
  const { data: dashboard, isLoading } = useGetDashboard()

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold tracking-tight text-foreground">Сводка</h1>
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {[...Array(4)].map((_, i) => (
            <Card key={i} className="animate-pulse">
              <CardHeader className="h-24 bg-muted/50" />
            </Card>
          ))}
        </div>
      </div>
    )
  }

  if (!dashboard) return null;

  return (
    <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Сводка</h1>
          <p className="text-muted-foreground mt-1">Оценка состояния склада на сегодня</p>
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
        <Card className="hover-elevate transition-all">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Всего товаров</CardTitle>
            <Package className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{dashboard.totalProducts}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Активных позиций
            </p>
          </CardContent>
        </Card>
        <Card className="hover-elevate transition-all">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Единиц на складе</CardTitle>
            <Flower2 className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{dashboard.totalUnits}</div>
            <p className="text-xs text-muted-foreground mt-1">
              Стеблей, штук, упаковок
            </p>
          </CardContent>
        </Card>
        <Card className="hover-elevate transition-all border-destructive/20 bg-destructive/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-destructive">Заканчиваются</CardTitle>
            <TrendingDown className="h-4 w-4 text-destructive" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-destructive">{dashboard.lowStockCount}</div>
            <p className="text-xs text-destructive/80 mt-1">
              Позиций ниже минимума
            </p>
          </CardContent>
        </Card>
        <Card className="hover-elevate transition-all border-orange-500/20 bg-orange-500/5">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-orange-600">Сроки годности</CardTitle>
            <Clock className="h-4 w-4 text-orange-600" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold text-orange-600">{dashboard.expiringCount}</div>
            <p className="text-xs text-orange-600/80 mt-1">
              Партий истекают скоро
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-destructive" />
              Низкий остаток
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.lowStock.length === 0 ? (
              <p className="text-sm text-muted-foreground">Всё в порядке, дефицита нет.</p>
            ) : (
              <div className="space-y-4">
                {dashboard.lowStock.slice(0, 5).map(item => (
                  <div key={item.id} className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.variety || item.category}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-bold text-destructive">{item.currentStock} {item.unit}</p>
                      <p className="text-xs text-muted-foreground">Мин: {item.minimumStock}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="h-5 w-5 text-orange-500" />
              Истекающий срок годности
            </CardTitle>
          </CardHeader>
          <CardContent>
            {dashboard.expiring.length === 0 ? (
              <p className="text-sm text-muted-foreground">Нет партий с истекающим сроком.</p>
            ) : (
              <div className="space-y-4">
                {dashboard.expiring.slice(0, 5).map(batch => (
                  <div key={`${batch.productId}-${batch.expiresAt}`} className="flex items-center justify-between">
                    <div>
                      <p className="font-medium">{batch.productName}</p>
                      <p className="text-xs text-muted-foreground">Кол-во: {batch.quantity}</p>
                    </div>
                    <div className="text-right flex flex-col items-end gap-1">
                      <Badge variant={batch.daysLeft <= 1 ? "destructive" : "warning"}>
                        {batch.daysLeft === 0 ? 'Сегодня' : `Осталось ${batch.daysLeft} дн.`}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Последние операции</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {dashboard.recentMovements.slice(0, 5).map(movement => (
              <div key={movement.id} className="flex items-center justify-between border-b pb-4 last:border-0 last:pb-0">
                <div className="flex items-center gap-4">
                  <div className={`w-2 h-2 rounded-full ${
                    ['receipt', 'production_output'].includes(movement.type) ? 'bg-green-500' :
                    ['expense', 'production_input'].includes(movement.type) ? 'bg-blue-500' :
                    movement.type === 'writeoff' ? 'bg-destructive' : 'bg-gray-500'
                  }`} />
                  <div>
                    <p className="font-medium">{movement.productName}</p>
                    <p className="text-xs text-muted-foreground">{formatDateTime(movement.createdAt)}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className={`font-bold ${
                    ['receipt', 'production_output'].includes(movement.type) ? 'text-green-600' :
                    ['expense', 'production_input'].includes(movement.type) ? 'text-blue-600' :
                    movement.type === 'writeoff' ? 'text-destructive' : ''
                  }`}>
                    {['receipt', 'production_output'].includes(movement.type) ? '+' : '-'}{movement.quantity}
                  </p>
                  <p className="text-xs text-muted-foreground capitalize">
                    {/* Подписи те же, что в истории операций: один тип не должен
                        называться по-разному на двух экранах. */}
                    {movement.type === 'receipt' ? 'Приход' :
                     movement.type === 'expense' ? 'Продажа' :
                     movement.type === 'writeoff' ? 'Списание' : 
                     movement.type === 'production_input' ? 'Сборка' :
                     movement.type === 'production_output' ? 'Готовый букет' :
                     movement.type}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
