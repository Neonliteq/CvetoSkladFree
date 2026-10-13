import {
  ArrowDownRight,
  ArrowUpRight,
  PackageMinus,
  PackagePlus,
  XCircle,
  type LucideIcon,
} from "lucide-react"

export type MovementTypeDetails = {
  label: string
  color: string
  bg: string
  icon: LucideIcon
  /** Whether the movement puts goods on the shelf or takes them away. */
  incoming: boolean
}

/**
 * Presentation of a movement type, shared by the desktop table and the mobile
 * card list so a new movement type cannot look different in the two layouts.
 */
export function getMovementTypeDetails(type: string): MovementTypeDetails {
  switch (type) {
    case "receipt":
      return { label: "Приход", color: "text-green-600", bg: "bg-green-500/10", icon: ArrowDownRight, incoming: true }
    case "expense":
      return { label: "Продажа", color: "text-blue-600", bg: "bg-blue-500/10", icon: ArrowUpRight, incoming: false }
    case "writeoff":
      return { label: "Списание", color: "text-destructive", bg: "bg-destructive/10", icon: XCircle, incoming: false }
    case "production_input":
      // «Сборка» — так эту строку создаёт производство букета; кнопки для такого
      // расхода в операциях нет, но в истории он остаётся.
      return { label: "Сборка", color: "text-orange-600", bg: "bg-orange-500/10", icon: PackageMinus, incoming: false }
    case "production_output":
      return { label: "Готовый букет", color: "text-purple-600", bg: "bg-purple-500/10", icon: PackagePlus, incoming: true }
    default:
      return { label: type, color: "text-gray-600", bg: "bg-gray-100", icon: ArrowUpRight, incoming: false }
  }
}

/** Signed quantity as shown in the lists. */
export function signedQuantity(type: string, quantity: number) {
  return `${getMovementTypeDetails(type).incoming ? "+" : "−"}${quantity}`
}

/** Все поля операции, которые нужны уведомлению. */
export type MovementNoticeInput = {
  type: string
  productName: string
  quantity: number
  unit?: string | null
  /** Цена за единицу: закупка для прихода, продажи — для продажи. */
  unitPrice?: number | null
  saleUnitPrice?: number | null
  totalCost?: number | null
  excludeFromStats?: boolean | null
}

/**
 * Описание операции для всплывающего уведомления.
 *
 * «Операция успешно проведена» ничего не говорит: кладовщик проводит десятки
 * операций подряд и по такому сообщению не понимает, что именно записалось.
 * Поэтому в уведомлении — вид операции, товар, количество с единицей и деньги,
 * если они есть.
 */
export function describeMovementForNotice(movement: MovementNoticeInput): string {
  const details = getMovementTypeDetails(movement.type)
  const unit = movement.unit || "ед."
  const parts = [
    movement.productName,
    `${signedQuantity(movement.type, movement.quantity)} ${unit}`,
  ]

  if (movement.type === "expense") {
    const price = movement.saleUnitPrice ?? null
    const revenue =
      price !== null ? price * movement.quantity : (movement.totalCost ?? null)
    if (price !== null) parts.push(`по ${formatMoney(price)} за ${unit}`)
    if (revenue !== null) parts.push(`выручка ${formatMoney(revenue)}`)
  } else if (movement.type === "receipt") {
    const price = movement.unitPrice ?? 0
    if (price > 0) parts.push(`по ${formatMoney(price)} за ${unit}`)
    const total = price * movement.quantity
    if (total > 0) parts.push(`сумма ${formatMoney(total)}`)
  } else if (movement.type === "writeoff") {
    // У списания важна сумма потери: она считается по списанным партиям.
    if (movement.totalCost) parts.push(`на ${formatMoney(movement.totalCost)}`)
  }

  if (movement.excludeFromStats) parts.push("не в статистике")

  return `${details.label}: ${parts.join(" · ")}`
}

/** Рубли без копеек: уведомление читают глазами, а не сверяют с отчётом. */
function formatMoney(value: number): string {
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 }).format(value)} ₽`
}
