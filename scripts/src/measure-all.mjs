/**
 * Prints a compact layout-fit report for every UI route.
 *
 * Usage: node scripts/src/measure-all.mjs [width] [height]
 *
 * For each route it reports how much horizontal room the content needs versus
 * how much the layout shell gives it, so clipping/overflow is a number instead
 * of a guess.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signInBrowser } from "./auth-helper.mjs";

const width = Number(process.argv[2] ?? 1440);
const height = Number(process.argv[3] ?? 900);
const base = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const port = 9334;

const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-measure-all-"));

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

const probe = `(() => {
  const doc = document.documentElement;
  const main = document.querySelector('main');
  const shell = document.querySelector('main > div');
  const sidebar = document.querySelector('main')?.previousElementSibling;
  const surface = document.querySelector('table')?.parentElement
    ?? document.querySelector('.rounded-xl.border');
  return {
    shellWidth: Math.round(shell?.getBoundingClientRect().width ?? 0),
    mainWidth: Math.round(main?.getBoundingClientRect().width ?? 0),
    tableWrapper: surface ? {
      clientWidth: surface.clientWidth,
      scrollWidth: surface.scrollWidth,
      clipped: surface.scrollWidth - surface.clientWidth,
      overflowX: getComputedStyle(surface).overflowX,
    } : null,
    actions: (() => {
      const row = document.querySelector('tbody tr');
      const last = row?.lastElementChild;
      if (!row || !last || !surface) return null;
      const right = last.getBoundingClientRect().right;
      return {
        right: Math.round(right),
        surfaceRight: Math.round(surface.getBoundingClientRect().right),
        visible: right <= surface.getBoundingClientRect().right + 0.5,
      };
    })(),
    pageOverflow: doc.scrollWidth - doc.clientWidth,
  };
})()`;

const routes = ["/", "/products", "/bouquets", "/movements", "/analytics", "/assistant"];

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  const session = await signInBrowser(cdp, base);
  console.log('signed in:', session.cookies.map((c) => c.name).join(', '));
  await cdp.send("Page.enable");
  console.log(`viewport ${width}x${height}\n`);
  for (const route of routes) {
    await cdp.send("Page.navigate", { url: `${base}${route}` });
    await sleep(2600);
    const result = await cdp.send("Runtime.evaluate", {
      expression: probe,
      returnByValue: true,
    });
    const value = result.result.value;
    const wrapper = value.tableWrapper;
    console.log(
      `${route.padEnd(11)} shell=${String(value.shellWidth).padStart(4)}  ` +
        (wrapper
          ? `table=${String(wrapper.clientWidth).padStart(4)}/${String(wrapper.scrollWidth).padStart(4)} ` +
            `clip=${String(wrapper.clipped).padStart(4)} (${wrapper.overflowX})  `
          : "no table surface".padEnd(36)) +
        (value.actions ? `lastCellVisible=${value.actions.visible}` : ""),
    );
  }
  cdp.close();
} finally {
  browser.kill();
  await sleep(500);
  rmSync(profile, { recursive: true, force: true });
}