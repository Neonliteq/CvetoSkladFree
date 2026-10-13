import type { ComponentType } from "react"
import { Link, useLocation } from "wouter"
import { LayoutDashboard, Package, ArrowRightLeft, Sparkles, Sprout, Gift, Activity, Download, Users, Settings, LogOut, Loader2 } from "lucide-react"
import { useInstallPrompt } from "@/hooks/use-pwa"
import { useCurrentUser } from "@/lib/auth-context"

export type NavItem = {
  href: string
  // lucide icons are typed with extra statics, so a plain component type is used.
  icon: ComponentType<{ className?: string }>
  label: string
  /** Hidden from staff accounts. */
  adminOnly?: boolean
}

export const navItems: NavItem[] = [
  { href: "/", icon: LayoutDashboard, label: "Сводка" },
  { href: "/products", icon: Package, label: "Склад" },
  { href: "/bouquets", icon: Gift, label: "Букеты" },
  { href: "/movements", icon: ArrowRightLeft, label: "Операции" },
  { href: "/analytics", icon: Activity, label: "Аналитика" },
  { href: "/assistant", icon: Sparkles, label: "AI Ассистент" },
  { href: "/users", icon: Users, label: "Сотрудники", adminOnly: true },
]

/**
 * Пункты, которые живут внизу, рядом с учётной записью.
 *
 * Настройки — редкое действие и всегда личное для администратора: в общем меню
 * они стоят наравне с ежедневными разделами и мешают. Внизу они читаются как
 * «про меня и сервис», а не «рабочий раздел».
 */
export const accountNavItems: NavItem[] = [
  { href: "/settings", icon: Settings, label: "Настройки", adminOnly: true },
]

/** Label of the section the given path belongs to. */
export function sectionTitle(path: string) {
  const match = [...navItems, ...accountNavItems]
    .filter((item) => item.href !== "/")
    .find((item) => path.startsWith(item.href))
  return match?.label ?? navItems[0].label
}

export function Brand() {
  return (
    <div className="flex h-16 items-center gap-3 px-6 py-4 font-serif text-xl font-bold tracking-wide">
      <Sprout className="h-6 w-6 text-sidebar-primary" />
      <span>ФлораСклад</span>
    </div>
  )
}

/** Ссылка меню: одна на рельсу и шторку, чтобы вид не разъезжался. */
function SidebarLink({
  item,
  isActive,
  onNavigate,
  className = "",
}: {
  item: NavItem
  isActive: boolean
  onNavigate?: () => void
  className?: string
}) {
  const Icon = item.icon
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={isActive ? "page" : undefined}
      className={`flex items-center gap-3 rounded-lg px-3 py-3 text-base transition-colors md:py-2.5 md:text-sm ${
        isActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
          : "text-sidebar-foreground/80 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
      } ${className}`}
    >
      <Icon className="h-5 w-5" />
      <span>{item.label}</span>
    </Link>
  )
}

/**
 * Navigation links, shared by the desktop rail and the mobile drawer so the two
 * cannot drift apart. `onNavigate` lets the drawer close itself after a tap.
 */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation()
  const { user } = useCurrentUser()
  const visibleItems = navItems.filter((item) => !item.adminOnly || user.role === "admin")
  const isActive = (href: string) =>
    location === href || (href !== "/" && location.startsWith(href))

  return (
    <nav className="flex-1 space-y-2 px-4 py-6">
      <div className="mb-4 px-2 text-xs font-semibold uppercase tracking-wider text-sidebar-foreground/50">
        Меню
      </div>
      {visibleItems.map((item) => (
        <SidebarLink
          key={item.href}
          item={item}
          isActive={isActive(item.href)}
          onNavigate={onNavigate}
        />
      ))}
    </nav>
  )
}

export function SidebarUser({ onNavigate }: { onNavigate?: () => void }) {
  const { canInstall, install } = useInstallPrompt()
  const { user, signOut, isSigningOut } = useCurrentUser()
  const [location] = useLocation()
  const accountItems = accountNavItems.filter(
    (item) => !item.adminOnly || user.role === "admin",
  )

  return (
    <div className="border-t border-sidebar-border p-4">
      {canInstall && (
        <button
          type="button"
          onClick={install}
          className="mb-3 flex w-full items-center gap-2 rounded-lg bg-sidebar-accent/60 px-3 py-3 text-sm font-medium text-sidebar-accent-foreground transition-colors hover:bg-sidebar-accent"
        >
          <Download className="h-4 w-4 shrink-0" />
          Установить на телефон
        </button>
      )}

      {/* Настройки — рядом с учётной записью: это личное действие
          администратора, а не ежедневный раздел склада. */}
      {accountItems.map((item) => (
        <SidebarLink
          key={item.href}
          item={item}
          isActive={location === item.href || location.startsWith(item.href)}
          onNavigate={onNavigate}
          className="mb-2"
        />
      ))}

      <div className="flex items-center gap-3 px-2">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sidebar-primary font-bold text-sidebar-primary-foreground">
          {user.displayName.slice(0, 1).toLocaleUpperCase("ru")}
        </div>
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-medium">{user.displayName}</span>
          <span className="text-xs text-sidebar-foreground/60">
            {user.role === "admin" ? "Администратор" : "Сотрудник"}
          </span>
        </div>
        <button
          type="button"
          onClick={signOut}
          disabled={isSigningOut}
          aria-label="Выйти"
          title="Выйти"
          className="ml-auto flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-foreground disabled:opacity-60"
        >
          {isSigningOut ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <LogOut className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  )
}
