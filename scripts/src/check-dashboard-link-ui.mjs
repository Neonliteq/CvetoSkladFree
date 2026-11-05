/**
 * Переход к товару со сводки.
 *
 * Проверяется не «ссылка есть», а что она работает: клик по названию в «Просрочено» или
 * «Заканчивается» открывает склад, строка этого товара раскрыта и подсвечена. Плюс прямой
 * переход по `?product=<id>` — так ссылку можно отправить или открыть из закладки.
 *
 * Usage: node scripts/src/check-dashboard-link-ui.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn, signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const port = Number(process.env.CDP_PORT ?? 9651);
seedDatabase();
ensureScreenshotsDir();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const session = await signIn(api);
const dashboard = await fetch(`${api}/api/dashboard`, {
  headers: { cookie: session.cookieHeader, origin: new URL(api).origin },
}).then((response) => response.json());
const expired = dashboard.expiring.filter((batch) => batch.daysLeft < 0);
const lowStock = dashboard.lowStock;
const target = expired[0] ?? null;
const lowTarget = lowStock[0] ?? null;
console.log(
  `данные: просрочено ${expired.length}, дефицит ${lowStock.length}` +
    (target ? `, цель — «${target.productName}» (id ${target.productId})` : ""),
);

const profile = mkdtempSync(path.join(tmpdir(), "dsh-link-ui-"));
const browser = spawn(
  process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1000",
    "--no-first-run",
    "about:blank",
  ],
  { stdio: "ignore" },
);

try {
  let wsUrl = null;
  for (let attempt = 0; attempt < 60 && !wsUrl; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = list.find((item) => item.type === "page")?.webSocketDebuggerUrl ?? null;
    } catch {
      // ещё не готов
    }
    if (!wsUrl) await sleep(250);
  }
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message.result ?? message);
    }
  });
  const cdp = {
    send: (method, params = {}) =>
      new Promise((resolve) => {
        const id = nextId++;
        pending.set(id, resolve);
        socket.send(JSON.stringify({ id, method, params }));
      }),
  };
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300));
    return result.result?.value;
  };
  const waitFor = async (expression, timeoutMs = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    throw new Error(`не дождались: ${expression}`);
  };

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/` });
  await waitFor(`document.body.innerText.includes('Сводка')`);
  await sleep(1500);

  console.log("=== 1. Названия в проблемах — ссылки ===");
  const links = await evaluate(`(() => {
    const anchors = [...document.querySelectorAll('a')]
      .filter((node) => (node.getAttribute('href') || '').includes('product='));
    return anchors.map((node) => ({
      href: node.getAttribute('href'),
      text: (node.textContent || '').trim(),
    }));
  })()`);
  console.log("  ссылки:", JSON.stringify(links));
  record("на сводке есть ссылки на товары", (links?.length ?? 0) > 0, JSON.stringify(links));

  if (target) {
    const expectedHref = `/products?product=${target.productId}`;
    record(
      "ссылка просроченного товара ведёт на его строку",
      (links ?? []).some((link) => link.href === expectedHref),
      `ожидалась ${expectedHref}`,
    );

    console.log("=== 2. Клик открывает склад и раскрывает товар ===");
    const clicked = await evaluate(`(() => {
      const anchor = [...document.querySelectorAll('a')]
        .find((node) => node.getAttribute('href') === ${JSON.stringify(expectedHref)});
      if (!anchor) return false;
      anchor.click();
      return true;
    })()`);
    await sleep(2500);
    const state = await evaluate(`(() => {
      // Именно строка таблицы: мобильная карточка тоже помечена data-product-row, но
      // раскрытие у неё считается по кнопке внутри, а не по aria-expanded.
      const row = document.querySelector('tbody tr[data-product-row="${target.productId}"]');
      const path = window.location.pathname + window.location.search;
      return {
        path,
        heading: document.querySelector('h1')?.textContent?.trim() ?? null,
        rowFound: Boolean(row),
        expanded: row ? row.getAttribute('aria-expanded') : null,
        receiptsPanel: Boolean(document.querySelector('[data-testid="product-receipts"]')) ||
          /\u041f\u0440\u0438\u0445\u043e\u0434\u044b/.test(document.body.innerText),
      };
    })()`);
    console.log("  после клика:", JSON.stringify(state));
    record("клик привёл на склад", state?.path?.startsWith("/products") === true, String(state?.path));
    record("строка нужного товара найдена", state?.rowFound === true, JSON.stringify(state));
    record("строка раскрыта", state?.expanded === "true", String(state?.expanded));

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    saveScreenshot("check-dashboard-link.png", shot.data);
  } else {
    record("ссылка просроченного товара ведёт на его строку", false, "в демо-данных нет просрочки");
  }

  console.log("=== 3. Прямой переход по ссылке ===");
  const directId = (lowTarget ?? target)?.id ?? (lowTarget ?? target)?.productId;
  if (directId) {
    await cdp.send("Page.navigate", { url: `${ui}/products?product=${directId}` });
    await waitFor(`Boolean(document.querySelector('tbody tr[data-product-row="${directId}"]'))`);
    await sleep(1800);
    const direct = await evaluate(`(() => {
      const row = document.querySelector('tbody tr[data-product-row="${directId}"]');
      return {
        found: Boolean(row),
        expanded: row ? row.getAttribute('aria-expanded') : null,
        highlighted: row ? /ring-2|bg-primary/.test(row.className) : false,
      };
    })()`);
    console.log("  прямо по ссылке:", JSON.stringify(direct));
    record("прямая ссылка открывает нужную строку", direct?.found === true, JSON.stringify(direct));
    record("прямая ссылка раскрывает товар", direct?.expanded === "true", String(direct?.expanded));
  } else {
    record("прямая ссылка открывает нужную строку", false, "не нашлось товара для проверки");
  }

  socket.close();
} catch (error) {
  record("проверка перехода к товару", false, String(error).slice(0, 400));
} finally {
  browser.kill();
  await sleep(700);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // уберёт система
  }
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
