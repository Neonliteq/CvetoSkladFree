/**
 * Verifies the PWA behaviour that only exists in a production build: the service
 * worker registers, serves the shell offline, serves the cached read endpoints
 * offline, and takes over after a reload.
 *
 * Usage: node scripts/src/check-pwa.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signInBrowser } from "./auth-helper.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..");
const distDir = path.join(root, "artifacts", "flower-stock", "dist", "public");
const port = 4173;
const debugPort = 9345;
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

if (!existsSync(path.join(distDir, "index.html"))) {
  throw new Error("Build the frontend first: pnpm --filter @workspace/flower-stock run build");
}
if (!existsSync(path.join(distDir, "sw.js"))) {
  throw new Error("sw.js is missing from the build output");
}

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
};

/**
 * Static server with an SPA fallback, standing in for the reverse proxy: pages
 * come from the build output, `/api/*` is proxied to the real API server so the
 * service worker caches genuine JSON.
 */
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);

  if (url.pathname.startsWith("/api/")) {
    try {
      const upstream = await fetch(`http://127.0.0.1:5000${url.pathname}${url.search}`, {
        method: request.method,
        headers: {
          accept: "application/json",
          // The API is authenticated, so the browser's cookie has to be forwarded.
          ...(request.headers.cookie ? { cookie: request.headers.cookie } : {}),
        },
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      response.writeHead(upstream.status, {
        "Content-Type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(body);
    } catch (error) {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: String(error) }));
    }
    return;
  }

  let filePath = path.join(distDir, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(distDir)) {
    response.writeHead(403).end();
    return;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = path.join(distDir, "index.html");
  }
  const body = readFileSync(filePath);
  response.writeHead(200, {
    "Content-Type": contentTypes[path.extname(filePath)] ?? "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  response.end(body);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggingTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // not ready
    }
    await sleep(250);
  }
  throw new Error("Could not reach the Edge debugging endpoint");
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(wsUrl) {
    const client = new Cdp();
    client.#socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener("open", resolve, { once: true });
      client.#socket.addEventListener("error", reject, { once: true });
    });
    client.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = client.#pending.get(message.id);
      if (!pending) return;
      client.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    return client;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 30000);
    });
  }

  close() {
    this.#socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

const results = [];
const record = (label, ok) => results.push([label, Boolean(ok)]);

await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
const profile = mkdtempSync(path.join(tmpdir(), "dsh-pwa-"));
const browser = spawn(
  edge,
  [
    "--headless=new",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  // The session cookie has to be in place before the app boots, otherwise the
  // shell loads signed out and nothing but the sign-in form is cached.
  const bootSession = await signInBrowser(cdp, `http://127.0.0.1:${port}`);
  console.log("signed in:", bootSession.cookies.map((cookie) => cookie.name).join(", "));
  await cdp.send("Runtime.enable");
  // Keep the offline failure visible in the report.
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__offlineErrors = [];
      window.addEventListener('error', (event) => {
        window.__offlineErrors.push(String(event.message ?? event.error));
      });
      window.addEventListener('unhandledrejection', (event) => {
        window.__offlineErrors.push('unhandled: ' + String(event.reason));
      });
    `,
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/` });
  await sleep(4000);

  const sw = await evaluate(
    cdp,
    `(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      const registration = await navigator.serviceWorker.getRegistration();
      const manifest = document.querySelector('link[rel=manifest]')?.getAttribute('href') ?? null;
      const icons = await fetch('/manifest.webmanifest')
        .then((r) => r.json())
        .then((m) => m.icons.map((i) => i.sizes))
        .catch(() => []);
      return {
        supported: true,
        scope: registration?.scope ?? null,
        active: Boolean(registration?.active),
        manifest,
        icons,
        themeColor: document.querySelector('meta[name=theme-color]')?.content ?? null,
      };
    })()`,
  );
  console.log("service worker:", JSON.stringify(sw));
  record("service worker registers", sw.active === true);
  record("manifest is linked", sw.manifest === "/manifest.webmanifest");
  record("manifest declares 192 and 512 icons", (sw.icons ?? []).includes("192x192") && (sw.icons ?? []).includes("512x512"));

  await evaluate(cdp, `navigator.serviceWorker.ready.then(() => true)`);
  // Warm the cached read endpoints while still online. The requests run in the
  // page so they carry the session cookie and reach the service worker.
  const warmed = await evaluate(
    cdp,
    `Promise.all([
      fetch('/api/dashboard', { credentials: 'same-origin' }).then((r) => r.status),
      fetch('/api/products', { credentials: 'same-origin' }).then((r) => r.status),
    ])`,
  );
  console.log("warmed endpoints:", JSON.stringify(warmed));
  await sleep(1500);

  const cached = await evaluate(
    cdp,
    `(async () => {
      const names = await caches.keys();
      const shell = await caches.open(names.find((n) => n.endsWith('-shell')));
      const data = await caches.open(names.find((n) => n.endsWith('-data')));
      return {
        caches: names.length,
        shellEntries: (await shell.keys()).length,
        dataEntries: (await data.keys()).length,
      };
    })()`,
  );
  console.log("caches:", JSON.stringify(cached));
  record("shell assets are precached", cached.shellEntries >= 4);
  record("read endpoints are cached", cached.dataEntries >= 1);

  // Offline: the shell must still boot and the cached data must still render.
  await cdp.send("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  });
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/products` });
  await sleep(4000);
  const offline = await evaluate(
    cdp,
    `(() => ({
      title: document.title,
      hasRoot: Boolean(document.getElementById('root')?.children.length),
      heading: document.querySelector('h1')?.textContent?.trim() ?? null,
      cards: document.querySelectorAll('main .rounded-xl.border').length,
      banner: document.body.innerText.includes('Нет сети') ||
        document.body.innerText.includes('Нет связи со складом'),
    }))()`,
  );
  console.log("offline (cached screen):", JSON.stringify(offline));
  record("the app shell loads offline", offline.hasRoot === true);
  record("the products screen renders from cache offline", offline.cards > 0);

  // A screen whose data was never cached must report the problem instead of
  // rendering an empty page: this is what the banner is for.
  await cdp.send("Page.navigate", { url: `http://127.0.0.1:${port}/analytics` });
  await sleep(7000);
  const uncachedOffline = await evaluate(
    cdp,
    `(async () => {
      const probe = await fetch('/api/analytics/movements').then(
        (r) => 'ok:' + r.status,
        (error) => 'failed:' + String(error).slice(0, 60),
      );
      return {
        hasRoot: Boolean(document.getElementById('root')?.children.length),
        banner: document.body.innerText.includes('Нет сети') ||
          document.body.innerText.includes('Нет связи со складом'),
        onLine: navigator.onLine,
        directFetch: probe,
        text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 120),
      };
    })()`,
  );
  console.log("offline (uncached screen):", JSON.stringify(uncachedOffline));
  record("an offline notice is shown when data is missing", uncachedOffline.banner === true);
  record("the offline screen still renders the app", uncachedOffline.hasRoot === true);

  const consoleErrors = await evaluate(
    cdp,
    `(async () => {
      const names = await caches.keys();
      const data = await caches.open(names.find((n) => n.endsWith('-data')));
      const requests = await data.keys();
      const samples = [];
      for (const request of requests) {
        const response = await data.match(request);
        const body = await response.clone().text();
        samples.push({
          url: new URL(request.url).pathname,
          status: response.status,
          type: response.headers.get('content-type'),
          head: body.slice(0, 80),
        });
      }
      return { requests: requests.map((r) => new URL(r.url).pathname), samples };
    })()`,
  );
  console.log("cached responses:", JSON.stringify(consoleErrors, null, 2));
  record(
    "cached API payloads are JSON",
    (consoleErrors.samples ?? []).every((sample) =>
      String(sample.type).includes("application/json"),
    ),
  );

  await cdp.send("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  cdp.close();
} finally {
  browser.kill();
  server.close();
  await sleep(600);
  rmSync(profile, { recursive: true, force: true });
}

console.log("\nresults:");
let failed = 0;
for (const [label, ok] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);