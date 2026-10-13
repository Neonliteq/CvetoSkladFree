/**
 * Reports how each screen behaves on a narrow viewport: content width versus
 * what the layout gives it, clipping inside table wrappers, and elements that
 * stick out horizontally.
 *
 * Usage: node scripts/src/measure-mobile.mjs [width] [height]
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
const port = 9343;

const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-mobile-"));

const browser = spawn(
  edge,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
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

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

const probe = `(() => {
  const doc = document.documentElement;
  const box = (el) => {
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };
  const sidebar = document.querySelector('[data-sidebar]');
  const main = document.querySelector('main');
  const header = document.querySelector('header');
  const tableWrapper = document.querySelector('table')?.parentElement ?? null;
  const nav = [...document.querySelectorAll('[data-sidebar] a')];
  const composer = document.querySelector('form');
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    pageOverflowX: doc.scrollWidth - doc.clientWidth,
    docClientWidth: doc.clientWidth,
    bodyClientWidth: document.body.clientWidth,
    bodyScrollWidth: document.body.scrollWidth,
    bodyRect: box(document.body),
    shell: box(document.querySelector('body > div')),
    sidebar: { box: box(sidebar), display: sidebar ? getComputedStyle(sidebar).display : null },
    smallTargets: (() => {
      const controls = [...document.querySelectorAll('main button, main a, main [role=combobox], header button')];
      const small = controls
        .map((el) => {
          const rect = el.getBoundingClientRect();
          return { el, w: Math.round(rect.width), h: Math.round(rect.height) };
        })
        .filter(({ w, h }) => w > 0 && h > 0 && (h < 44 || w < 44));
      return {
        total: controls.length,
        small: small.length,
        examples: small.slice(0, 5).map(({ el, w, h }) => ({
          tag: el.tagName.toLowerCase(),
          label: (el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 28),
          size: w + 'x' + h,
        })),
      };
    })(),
    headerBar: box(header),
    main: box(main),
    navItems: nav.length,
    navItemBox: box(nav[0]),
    table: tableWrapper
      ? {
          client: tableWrapper.clientWidth,
          scroll: tableWrapper.scrollWidth,
          scrollable: tableWrapper.scrollWidth > tableWrapper.clientWidth,
        }
      : null,
    composer: box(composer),
    chatArea: box(document.querySelector('.overflow-y-auto')),
    visibleMessages: [...document.querySelectorAll('.overflow-y-auto p')].filter((p) => {
      const rect = p.getBoundingClientRect();
      return rect.height > 0 && rect.bottom < window.innerHeight;
    }).length,
  };
})()`;

const routes = ["/", "/products", "/bouquets", "/movements", "/analytics", "/assistant"];

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  const session = await signInBrowser(cdp, base);
  console.log('signed in:', session.cookies.map((c) => c.name).join(', '));
  await cdp.send("Page.enable");
  // `--window-size` does not give a real mobile viewport in headless mode, so the
  // width (and therefore every media query) is emulated explicitly.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  console.log(`viewport ${width}x${height} (emulated, mobile)\n`);
  for (const route of routes) {
    await cdp.send("Page.navigate", { url: `${base}${route}` });
    await sleep(2600);
    const result = await cdp.send("Runtime.evaluate", {
      expression: probe,
      returnByValue: true,
    });
    const value = result.result.value;
    console.log(
      `${route.padEnd(11)} overflowX=${String(value.pageOverflowX).padStart(4)} ` +
        `inner=${value.viewport.w} docClient=${value.docClientWidth} body=${value.bodyClientWidth}/${value.bodyScrollWidth} ` +
        `shell=${value.shell.width} main=${value.main.width}@${value.main.x} ` +
        (value.table
          ? `table=${value.table.client}/${value.table.scroll}${value.table.scrollable ? " scroll" : ""} `
          : "") +
        (route === "/assistant"
          ? `chat=${value.chatArea?.height} composer=${value.composer?.height} msgsVisible=${value.visibleMessages}`
          : "") +
        ` | tapTargets<44px: ${value.smallTargets.small}/${value.smallTargets.total}`,
    );
    if (value.smallTargets.small > 0) {
      console.log("   small:", JSON.stringify(value.smallTargets.examples));
    }
  }

  // A screenshot of the assistant and of the opened drawer are the states that
  // matter most on a phone.
  await cdp.send("Page.navigate", { url: `${base}/assistant` });
  await sleep(3000);
  const beforeShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-mobile-assistant.png"),
    Buffer.from(beforeShot.data, "base64"),
  );

  const drawer = await evaluate(
    cdp,
    `(async () => {
      const menuButton = document.querySelector('button[aria-label="Открыть меню"]');
      if (!menuButton) return { menuButton: false };
      const barHeight = Math.round(
        document.querySelector('header')?.getBoundingClientRect().height ?? 0,
      );
      menuButton.click();
      await new Promise((resolve) => setTimeout(resolve, 700));
      const panel = document.querySelector('[data-sidebar="drawer"]');
      const links = panel ? panel.querySelectorAll('a').length : 0;
      const panelBox = panel?.getBoundingClientRect();
      const shotState = {
        panelOpen: Boolean(panel),
        links,
        panelWidth: Math.round(panelBox?.width ?? 0),
        barHeight,
        railHidden: getComputedStyle(document.querySelector('[data-sidebar="rail"]')).display === 'none',
      };
      // Following a link must navigate and close the drawer.
      const products = panel
        ? [...panel.querySelectorAll('a')].find((a) => a.textContent?.includes('Склад'))
        : null;
      products?.click();
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return {
        ...shotState,
        navigatedTo: window.location.pathname,
        drawerClosedAfterTap: !document.querySelector('[data-sidebar="drawer"]'),
        titleAfterTap: document.querySelector('header span')?.textContent ?? null,
      };
    })()`,
  );
  console.log("\nmobile drawer:", JSON.stringify(drawer, null, 2));

  const drawerShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-mobile-after-nav.png"),
    Buffer.from(drawerShot.data, "base64"),
  );
  cdp.close();
} finally {
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}