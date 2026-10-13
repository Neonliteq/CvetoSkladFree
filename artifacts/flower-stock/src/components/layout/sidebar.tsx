import * as React from "react"
import { useLocation } from "wouter"
import { cn } from "@/lib/utils"
import { Brand, SidebarNav, SidebarUser, sectionTitle } from "./navigation"
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet"

type SidebarProps = {
  /** Drawer state, controlled by the layout's top bar. */
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Sidebar for both form factors: a fixed rail from `md` up, and a slide-in
 * drawer below it. Below `md` the rail is hidden because it used to leave the
 * content a few dozen pixels wide.
 */
export function Sidebar({ open, onOpenChange }: SidebarProps) {
  const [location] = useLocation()

  return (
    <>
      <aside
        data-sidebar="rail"
        className="hidden h-screen w-64 shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-all duration-300 md:flex"
      >
        <Brand />
        <SidebarNav />
        <SidebarUser />
      </aside>

      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side="left"
          data-sidebar="drawer"
          className="flex w-[17rem] flex-col gap-0 border-sidebar-border bg-sidebar p-0 text-sidebar-foreground sm:max-w-[17rem]"
        >
          <SheetTitle className="sr-only">Меню склада</SheetTitle>
          <Brand />
          {/* Tapping a link navigates and closes the drawer in one gesture. */}
          <SidebarNav onNavigate={() => onOpenChange(false)} />
          {/* Настройки живут рядом с учётной записью и в шторке закрывают её. */}
          <SidebarUser onNavigate={() => onOpenChange(false)} />
        </SheetContent>
      </Sheet>
    </>
  )
}

export function MobileTopBar({
  onOpenMenu,
  className,
}: {
  onOpenMenu: () => void
  className?: string
}) {
  const [location] = useLocation()

  return (
    <header
      className={cn(
        "flex h-14 shrink-0 items-center gap-3 border-b bg-sidebar px-3 text-sidebar-foreground md:hidden",
        className,
      )}
    >
      <button
        type="button"
        onClick={onOpenMenu}
        aria-label="Открыть меню"
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-sidebar-foreground transition-colors hover:bg-sidebar-accent/60 active:bg-sidebar-accent"
      >
        <MenuIcon />
      </button>
      <span className="truncate font-serif text-lg font-bold tracking-wide">
        {sectionTitle(location)}
      </span>
      <span className="ml-auto pr-1 text-xs text-sidebar-foreground/60">ФлораСклад</span>
    </header>
  )
}

function MenuIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      className="h-6 w-6"
      aria-hidden="true"
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  )
}
