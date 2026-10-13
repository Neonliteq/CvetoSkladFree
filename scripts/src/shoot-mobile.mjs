/**
 * Captures every screen at a mobile width so the layout can be inspected, and
 * fails loudly if a screen starts scrolling sideways.
 *
 * Usage: node scripts/src/shoot-mobile.mjs [width] [height]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 390);
const height = Number(process.argv[3] ?? 844);
const base = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const port = 9344;
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-mobile-shots-"));

const browser = spawn(
  edge,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggingTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
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

const routes = [
  ["/", "dashboard"],
  ["/products", "products"],
  ["/bouquets", "bouquets"],
  ["/movements", "movements"],
  ["/analytics", "analytics"],
  ["/assistant", "assistant"],
];

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  const session = await signInBrowser(cdp, base);
  console.log('signed in:', session.cookies.map((c) => c.name).join(', '));
  await cdp.send("Page.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });

  let sideways = 0;
  for (const [route, name] of routes) {
    await cdp.send("Page.navigate", { url: `${base}${route}` });
    await sleep(2800);
    const check = await cdp.send("Runtime.evaluate", {
      expression: `(() => {
        const doc = document.documentElement;
        return {
          overflowX: doc.scrollWidth - doc.clientWidth,
          bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
          hasHeader: Boolean(document.querySelector('header')),
          heading: document.querySelector('h1')?.textContent?.trim().slice(0, 40) ?? null,
        };
      })()`,
      returnByValue: true,
    });
    const value = check.result.value;
    if (value.overflowX > 0 || value.bodyOverflow > 0) sideways += 1;
    console.log(
      `${name.padEnd(10)} overflowX=${value.overflowX} body=${value.bodyOverflow} ` +
        `mobileBar=${value.hasHeader} heading=${value.heading}`,
    );
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    saveScreenshot(`check-mobile-${name}.png`, shot.data);
  }
  console.log(sideways === 0 ? "\nno screen scrolls sideways" : `\n${sideways} screen(s) scroll sideways`);
  cdp.close();
  process.exitCode = sideways === 0 ? 0 : 1;
} finally {
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}