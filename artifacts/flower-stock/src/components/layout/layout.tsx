import { ReactNode, useEffect, useState } from "react"
import { useLocation } from "wouter"
import { MobileTopBar, Sidebar } from "./sidebar"
import { OfflineBanner } from "./offline-banner"

export function Layout({ children }: { children: ReactNode }) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false)
  const [location] = useLocation()

  // A route change must not leave the drawer open behind the new page.
  useEffect(() => {
    setIsDrawerOpen(false)
  }, [location])

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar open={isDrawerOpen} onOpenChange={setIsDrawerOpen} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileTopBar onOpenMenu={() => setIsDrawerOpen(true)} />
        <OfflineBanner />
        {/* No max-width cap: the data tables have eight columns and were being
            clipped by the old `max-w-6xl` container. `min-w-0` keeps wide table
            content from stretching <main> itself. Padding is tighter on phones
            so the narrow screen is not spent on margins. */}
        <main className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden px-3 py-4 sm:px-4 md:px-8 md:py-6">
          <div className="w-full">{children}</div>
        </main>
      </div>
    </div>
  )
}
