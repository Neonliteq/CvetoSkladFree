import { useEffect, useState } from "react"

/**
 * Connection state for the offline banner.
 *
 * `navigator.onLine` is only a hint (it is true on a captive portal), so the UI
 * wording stays calm: it tells the user that data may be outdated rather than
 * claiming the network is definitely down.
 */
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(
    typeof navigator === "undefined" ? true : navigator.onLine,
  )

  useEffect(() => {
    const goOnline = () => setIsOnline(true)
    const goOffline = () => setIsOnline(false)
    window.addEventListener("online", goOnline)
    window.addEventListener("offline", goOffline)
    return () => {
      window.removeEventListener("online", goOnline)
      window.removeEventListener("offline", goOffline)
    }
  }, [])

  return isOnline
}

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice?: Promise<{ outcome: "accepted" | "dismissed" }>
}

/**
 * "Add to home screen" support. Chromium fires `beforeinstallprompt` once the
 * app is installable; the event is kept so the button can trigger the native
 * dialog later, and hidden again once the app runs installed.
 */
export function useInstallPrompt() {
  const [promptEvent, setPromptEvent] = useState<InstallPromptEvent | null>(null)
  const [isInstalled, setIsInstalled] = useState(
    typeof window === "undefined"
      ? false
      : window.matchMedia("(display-mode: standalone)").matches,
  )

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setPromptEvent(event as InstallPromptEvent)
    }
    const onInstalled = () => {
      setIsInstalled(true)
      setPromptEvent(null)
    }
    window.addEventListener("beforeinstallprompt", onPrompt)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  const install = async () => {
    if (!promptEvent) return
    await promptEvent.prompt()
    const choice = await promptEvent.userChoice?.catch(() => undefined)
    if (choice?.outcome === "accepted") setIsInstalled(true)
    setPromptEvent(null)
  }

  return { canInstall: Boolean(promptEvent) && !isInstalled, install }
}
