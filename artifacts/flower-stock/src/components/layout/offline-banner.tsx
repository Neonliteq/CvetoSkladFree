import { useEffect, useState } from "react"
import { useQueryClient, type Query } from "@tanstack/react-query"
import { ApiError } from "@workspace/api-client-react"
import { useOnlineStatus } from "@/hooks/use-pwa"
import { CloudOff, RefreshCw } from "lucide-react"

/**
 * True when a request failed because the app cannot reach the API.
 *
 * A rejected request is not the same as an unreachable one: 401 and 403 are
 * answers from a working server, and showing "no connection" for them would
 * send the user hunting for a network problem that does not exist.
 */
function isConnectivityFailure(error: unknown) {
  if (error instanceof ApiError) {
    const status = error.response?.status ?? 0
    return status === 0 || status >= 500
  }
  return Boolean(error)
}

/**
 * Whether the app is cut off from the API.
 *
 * `navigator.onLine` alone is not enough: it stays `true` on a captive portal,
 * when the API process is down, and under some emulators. A failing query is the
 * signal that actually matters, so both are combined — and the online event
 * clears the flag immediately so the banner disappears without a reload.
 */
export function useOfflineStatus() {
  const isBrowserOnline = useOnlineStatus()
  const queryClient = useQueryClient()
  const [hasFailedRequest, setHasFailedRequest] = useState(false)

  useEffect(() => {
    const cache = queryClient.getQueryCache()
    const inspect = (query?: Query) => {
      if (!query) return
      const error = query.state.error
      if (query.state.status === "error" && isConnectivityFailure(error)) {
        setHasFailedRequest(true)
      } else if (query.state.status === "success") {
        setHasFailedRequest(false)
      }
    }
    const unsubscribe = cache.subscribe((event) => inspect(event?.query))
    cache.getAll().forEach((query) => inspect(query))
    return unsubscribe
  }, [queryClient])

  useEffect(() => {
    const reset = () => setHasFailedRequest(false)
    window.addEventListener("online", reset)
    return () => window.removeEventListener("online", reset)
  }, [])

  return {
    isOffline: !isBrowserOnline || hasFailedRequest,
    /** True when the browser itself reports no connectivity. */
    isBrowserOnline,
  }
}

/**
 * Offline notice.
 *
 * The service worker serves the dashboard, products, movements and bouquets from
 * cache, so the app stays readable without a network — but the numbers may be
 * from the last successful load and nothing can be posted. Saying that plainly
 * is the whole point of this banner.
 */
export function OfflineBanner() {
  const { isOffline, isBrowserOnline } = useOfflineStatus()
  const queryClient = useQueryClient()
  const [isRefreshing, setIsRefreshing] = useState(false)

  if (!isOffline) return null

  const refresh = async () => {
    setIsRefreshing(true)
    try {
      await queryClient.invalidateQueries()
      await queryClient.refetchQueries({ type: "active" })
    } finally {
      setIsRefreshing(false)
    }
  }

  return (
    <div
      role="status"
      className="flex items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 md:px-8"
    >
      <CloudOff className="h-4 w-4 shrink-0" />
      <span className="min-w-0 flex-1">
        {isBrowserOnline
          ? "Нет связи со складом. Показаны сохранённые данные, операции провести нельзя."
          : "Нет сети. Показаны сохранённые данные, операции провести нельзя."}
      </span>
      <button
        type="button"
        onClick={refresh}
        disabled={isRefreshing}
        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg px-3 font-medium text-amber-900 hover:bg-amber-500/20 disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${isRefreshing ? "animate-spin" : ""}`} />
        Обновить
      </button>
    </div>
  )
}
