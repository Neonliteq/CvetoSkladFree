/** Registers the service worker that provides the offline app shell. */
export function registerServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator)) return
  // The dev server serves modules one by one, so a caching worker there would
  // hide code changes and break HMR.
  if (!import.meta.env.PROD) return

  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Не удалось зарегистрировать service worker", error)
    })
  })
}
