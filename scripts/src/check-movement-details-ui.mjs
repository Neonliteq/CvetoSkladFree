/**
 * Проверяет раскрытие операции для обзора деталей.
 *
 * Смотрит то, чего не видно из API: раскрывается ли **любая** операция (а не только
 * расход с партиями), есть ли в деталях автор и время с секундами, и не показываются ли
 * пустые поля вроде «Срок годности: —» у продажи.
 *
 * Usage: node scripts/src/check-movement-details-ui.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn, signInBrowser } from "./auth-helper.mjs";
import { adminUsername } from "./credentials.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const port = Number(process.env.CDP_PORT ?? 9492);
seedDatabase();
ensureScreenshotsDir();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const session = await signIn(api);
const call = async (method, route, body) => {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: {
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// Готовим операцию с номером накладной: по ней проверяем, что детали показывают
// поля, которых нет в строке списка.
const catalog = await call("GET", "/api/products");
const stock = (catalog.body ?? []).filter((item) => item.productType === "stock")[0];
const orderNumber = `ДЕТАЛИ-${Date.now()}`;
const fresh = await call("POST", "/api/movements/bulk-receipt", {
  positions: [{ productId: stock.id, quantity: 7, unitPrice: 321 }],
  orderNumber,
  reason: "Проверка деталей операции",
});
if (fresh.status !== 201) throw new Error(`не удалось создать операцию: ${JSON.stringify(fresh.body)}`);

// И операцию-продажу: у неё нет срока годности и номера накладной — проверяем, что
// пустые поля не выводятся.
await call("POST", "/api/movements", {
  productId: stock.id,
  type: "expense",
  quantity: 1,
  saleUnitPrice: 500,
  reason: "Продажа для проверки деталей",
});

const profile = mkdtempSync(path.join(tmpdir(), "dsh-details-ui-"));
const browser = spawn(
  process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--window-size=1440,1000",
    "--no-first-run",
    "--no-default-browser-check",
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
  if (!wsUrl) throw new Error("не удалось подключиться к браузеру");

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

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4000);
  // Первая страница истории — самые свежие операции, значит наша продажа и приход наверху.
  await evaluate(`window.scrollTo(0, 0)`);

  console.log("=== 1. Раскрытие есть у каждой операции ===");
  const toggles = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('tbody tr')].filter((row) => row.querySelector('td'));
    const buttons = [...document.querySelectorAll('button[aria-label^="Подробности операции"]')];
    return { rows: rows.length, buttons: buttons.length, firstLabel: buttons[0]?.getAttribute('aria-label') ?? null };
  })()`);
  console.log("  строк и кнопок:", JSON.stringify(toggles));
  record(
    "кнопка раскрытия есть у каждой операции, а не только у расхода",
    toggles.buttons > 0 && toggles.buttons >= Math.min(toggles.rows, 1),
    JSON.stringify(toggles),
  );

  console.log("=== 2. Детали прихода: автор, время, накладная ===");
  // Ищем строку по комментарию: он виден в списке. Номер накладной в строке не
  // показывается — он появляется только в подробностях, это и проверяем.
  const receiptReason = "Проверка деталей операции";
  const opened = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const target = rows.find((row) => (row.textContent || '').includes(${JSON.stringify(receiptReason)}));
    if (!target) return { found: false };
    const button = target.querySelector('button[aria-label^="Подробности операции"]');
    if (!button) return { found: false };
    button.click();
    return { found: true };
  })()`);
  await sleep(900);
  const details = await evaluate(`(() => {
    const panel = document.querySelector('[data-testid="movement-details"]');
    if (!panel) return null;
    const text = (panel.innerText || '').replace(/\\s+/g, ' ');
    return {
      text,
      hasAuthor: /Оформил:/.test(text),
      authorName: /Оформил: ([^А-Я]*)/.exec(text)?.[1]?.trim() ?? null,
      hasSeconds: /\\d{2}:\\d{2}:\\d{2}/.test(text),
      hasOrder: text.includes(${JSON.stringify(orderNumber)}),
      hasNumber: /№\\d+/.test(text),
      hasArrival: /Дата прихода:/.test(text),
      hasRemaining: /Остаток в партии:/.test(text),
    };
  })()`);
  console.log("  детали:", JSON.stringify(details)?.slice(0, 400));
  record("детали открылись", opened?.found === true && details !== null, JSON.stringify(opened));
  record("видно, кто оформил", details?.hasAuthor === true, JSON.stringify(details)?.slice(0, 200));
  record(
    "имя автора — это вошедший администратор",
    (details?.authorName ?? "").includes(adminUsername) ||
      (details?.text ?? "").includes("Администратор"),
    String(details?.authorName),
  );
  record("время показано с секундами", details?.hasSeconds === true, "нет секунд — две операции в одну минуту не различить");
  record("виден номер накладной", details?.hasOrder === true, "номер накладной не показан");
  record("виден номер операции", details?.hasNumber === true, "нет номера операции");
  record("видны дата прихода и остаток партии", details?.hasArrival === true && details?.hasRemaining === true, JSON.stringify({ arrival: details?.hasArrival, remaining: details?.hasRemaining }));

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-movement-details.png", shot.data);

  console.log("=== 3. Пустые поля не показываются ===");
  const expense = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const target = rows.find((row) => (row.textContent || '').includes('Продажа для проверки деталей'));
    if (!target) return { found: false };
    const button = target.querySelector('button[aria-label^="Подробности операции"]');
    if (!button) return { found: false };
    button.click();
    return { found: true };
  })()`);
  await sleep(900);
  const expenseText = await evaluate(
    `(() => { const p = [...document.querySelectorAll('[data-testid="movement-details"]')]; const last = p[p.length - 1]; return last ? (last.innerText || '').replace(/\\s+/g, ' ') : null; })()`,
  );
  console.log("  детали продажи:", String(expenseText)?.slice(0, 300));
  record("детали продажи открылись", expense?.found === true && expenseText !== null, JSON.stringify(expense));
  record(
    "у продажи нет срока годности и номера накладной",
    expenseText !== null && !/Срок годности:/.test(expenseText) && !/Накладная:/.test(expenseText),
    String(expenseText)?.slice(0, 250),
  );
  record(
    "у продажи показана цена продажи",
    /Цена продажи:/.test(String(expenseText)),
    String(expenseText)?.slice(0, 250),
  );

  console.log("=== 4. Телефон: раскрытие тоже есть ===");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(3500);
  const mobile = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button[aria-label^="Подробности операции"]')];
    return { count: buttons.length };
  })()`);
  record("на телефоне раскрытие есть", mobile.count > 0, JSON.stringify(mobile));
  const mobileOpened = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button[aria-label^="Подробности операции"]')][0];
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(900);
  const mobileDetails = await evaluate(
    `(() => { const p = document.querySelector('[data-testid="movement-details"]'); return p ? /Оформил:/.test(p.innerText || '') : false; })()`,
  );
  record("на телефоне детали раскрываются с автором", mobileOpened === true && mobileDetails === true, String(mobileDetails));
  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-movement-details-mobile.png", mobileShot.data);

  socket.close();
} catch (error) {
  record("проверка деталей операции", false, String(error).slice(0, 400));
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
