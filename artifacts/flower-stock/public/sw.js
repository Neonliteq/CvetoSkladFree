/**
 * Service worker for ФлораСклад.
 *
 * Scope of the offline support: the app shell and read-only API responses. Any
 * request that changes stock still has to reach the server, because a queued
 * write could silently land twice or land out of order.
 */
const VERSION = "florasklad-v2";
const SHELL_CACHE = `${VERSION}-shell`;
const DATA_CACHE = `${VERSION}-data`;

/** Small, stable set that makes the app boot without a network. */
const SHELL_ASSETS = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/app-icon.svg",
  "/icon-192.png",
  "/icon-512.png",
];

/** Read endpoints worth keeping for offline viewing. */
const CACHEABLE_API = [
  "/api/dashboard",
  "/api/products",
  "/api/movements",
  "/api/bouquets",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // One missing file must not fail the whole installation.
      await Promise.all(
        SHELL_ASSETS.map((asset) => cache.add(asset).catch(() => undefined)),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((name) => !name.startsWith(VERSION)).map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

const isApiRequest = (url) => url.pathname.startsWith("/api/");

const isCacheableApi = (url, request) =>
  request.method === "GET" &&
  CACHEABLE_API.some((prefix) => url.pathname.startsWith(prefix));

/**
 * Only real JSON payloads may enter the data cache.
 *
 * A dev server, a login page or a router can answer an API path with HTML and a
 * 200 status; caching that would poison every later offline render, so the
 * content type is checked before the response is stored.
 */
const isJsonResponse = (response) =>
  response.ok &&
  (response.headers.get("content-type") ?? "").toLowerCase().includes("application/json");

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (url.origin !== self.location.origin) return;

  // Mutations never go through the cache: a stale or replayed write on a stock
  // system is worse than an error the user can see.
  if (request.method !== "GET") return;

  if (isApiRequest(url)) {
    if (!isCacheableApi(url, request)) return;
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (isJsonResponse(response)) {
            const cache = await caches.open(DATA_CACHE);
            cache.put(request, response.clone());
          }
          return response;
        } catch (error) {
          const cached = await caches.match(request);
          if (cached) return cached;
          throw error;
        }
      })(),
    );
    return;
  }

  // Navigations: fresh shell when online, cached shell when not.
  if (request.mode === "navigate") {
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          const cache = await caches.open(SHELL_CACHE);
          cache.put("/index.html", response.clone());
          return response;
        } catch (error) {
          const cached =
            (await caches.match("/index.html")) ?? (await caches.match("/"));
          if (cached) return cached;
          throw error;
        }
      })(),
    );
    return;
  }

  // Static assets are content-hashed by the bundler, so cache-first is safe.
  event.respondWith(
    (async () => {
      const cached = await caches.match(request);
      if (cached) return cached;
      const response = await fetch(request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(SHELL_CACHE);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
