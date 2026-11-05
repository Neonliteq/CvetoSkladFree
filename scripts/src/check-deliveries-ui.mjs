/**
 * Страница «Поставки»: список документов и контроль приходов.
 *
 * Ожидания берутся из `/api/deliveries`, а не из разметки: иначе проверка сверяла бы
 * страницу с самой собой. Смысл — убедиться, что на экране видно **кто и когда** провёл
 * приход, суммы совпадают с API и позиции раскрываются.
 *
 * Usage: node scripts/src/check-deliveries-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9641);
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

const products = (await call("GET", "/api/products")).body ?? [];
const stock = products.filter((item) => item.productType === "stock").slice(0, 2);
const orderNumber = `ПОСТАВКА-UI-${Date.now()}`;
const created = await call("POST", "/api/movements/bulk-receipt", {
  positions: [
    { productId: stock[0].id, quantity: 3, unitPrice: 120 },
    { productId: stock[1].id, quantity: 2, unitPrice: 300 },
  ],
  orderNumber,
  reason: "Проверка списка поставок",
});
if (created.status !== 201) throw new Error(`не удалось создать поставку: ${JSON.stringify(created.body)}`);

const expected = (await call("GET", `/api/deliveries?search=${encodeURIComponent(orderNumber)}`)).body?.items?.[0];
const expectedDetail = (await call("GET", `/api/deliveries/${encodeURIComponent(expected.key)}`)).body;
console.log(`поставка в API: ${expected.positions} поз., ${expected.quantity} ед., ${expected.cost} ₽`);

const profile = mkdtempSync(path.join(tmpdir(), "dsh-deliveries-ui-"));
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
  await cdp.send("Page.navigate", { url: `${ui}/deliveries` });
  await waitFor(`document.body.innerText.includes('Поставки')`);
  await sleep(2000);

  console.log("=== 1. Пункт меню и заголовок ===");
  const shell = await evaluate(`(() => ({
    hasMenu: [...document.querySelectorAll('a')].some((node) => (node.textContent || '').trim() === 'Поставки'),
    heading: document.querySelector('h1')?.textContent?.trim() ?? null,
    rows: document.querySelectorAll('tbody tr').length,
  }))()`);
  console.log("  экран:", JSON.stringify(shell));
  record("в меню есть «Поставки»", shell?.hasMenu === true, JSON.stringify(shell));
  record("заголовок страницы — «Поставки»", shell?.heading === "Поставки", String(shell?.heading));

  console.log("=== 2. Видно, кто и когда провёл приход ===");
  const table = await evaluate(`(() => {
    const header = [...document.querySelectorAll('thead th')].map((node) => (node.textContent || '').trim());
    const rows = [...document.querySelectorAll('tbody tr')];
    const row = rows.find((node) => (node.textContent || '').includes(${JSON.stringify(orderNumber)}));
    return {
      header,
      rowText: row ? (row.textContent || '').replace(/\\s+/g, ' ').trim() : null,
    };
  })()`);
  console.log("  колонки:", JSON.stringify(table?.header));
  console.log("  строка:", String(table?.rowText).slice(0, 200));
  record(
    "в шапке есть «Кто провёл» и «Проведено»",
    (table?.header ?? []).includes("Кто провёл") && (table?.header ?? []).includes("Проведено"),
    JSON.stringify(table?.header),
  );
  record(
    "строка поставки показывает её номер",
    String(table?.rowText ?? "").includes(orderNumber),
    String(table?.rowText)?.slice(0, 160),
  );
  record(
    "в строке есть автор прихода",
    Boolean(expected.createdByName) && String(table?.rowText ?? "").includes(expected.createdByName),
    `ожидался «${expected.createdByName}»`,
  );
  record(
    "в строке есть количество позиций и сумма",
    String(table?.rowText ?? "").includes(String(expected.positions)) &&
      String(table?.rowText ?? "").includes(String(expected.cost).replace(".", ",").replace(/\B(?=(\d{3})+(?!\d))/g, " ")),
    `ожидалось ${expected.positions} поз. и ${expected.cost} ₽`,
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-deliveries.png", shot.data);

  console.log("=== 3. Позиции раскрываются ===");
  await evaluate(`(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const row = rows.find((node) => (node.textContent || '').includes(${JSON.stringify(orderNumber)}));
    if (row) row.click();
    return Boolean(row);
  })()`);
  await sleep(1800);
  const positions = await evaluate(`(() => {
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    return {
      hasFirst: text.includes(${JSON.stringify(expectedDetail.movements[0].productName)}),
      hasSecond: text.includes(${JSON.stringify(expectedDetail.movements[1].productName)}),
      hasQuantity: text.includes(${JSON.stringify(String(expectedDetail.movements[0].quantity))}),
      text: text.slice(0, 400),
    };
  })()`);
  console.log("  позиции:", JSON.stringify({ first: positions?.hasFirst, second: positions?.hasSecond, quantity: positions?.hasQuantity }));
  record(
    "раскрылись обе позиции поставки",
    positions?.hasFirst === true && positions?.hasSecond === true,
    JSON.stringify(positions)?.slice(0, 200),
  );
  record("видны количества", positions?.hasQuantity === true, "количество первой позиции не найдено");

  const expandedShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-deliveries-expanded.png", expandedShot.data);

  console.log("=== 4. Поиск по номеру ===");
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder^="Номер накладной"]');
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    const previous = input.value;
    setter.call(input, ${JSON.stringify(orderNumber)});
    if (input._valueTracker) input._valueTracker.setValue(previous);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(2200);
  const filtered = await evaluate(`(() => {
    // Без строки позиций: у неё ячейка с colSpan, и она не документ.
    const rows = [...document.querySelectorAll('tbody tr')].filter((row) => row.querySelector('td') && !row.querySelector('td[colspan]'));
    return {
      rows: rows.length,
      texts: rows.map((row) => (row.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 60)),
    };
  })()`);
  console.log("  после поиска:", JSON.stringify(filtered)?.slice(0, 240));
  record(
    "поиск оставляет только эту поставку",
    filtered?.rows === 1 && String(filtered?.texts?.[0] ?? "").includes(orderNumber),
    JSON.stringify(filtered?.texts),
  );

  socket.close();
} catch (error) {
  record("проверка страницы поставок", false, String(error).slice(0, 400));
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
