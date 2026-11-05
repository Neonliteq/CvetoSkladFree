/**
 * Окно «Массовая операция» в настоящем браузере: приход, продажа, списание.
 *
 * Смотрит то, чего не видно из API: переключатель видов, разные поля у видов, подстановку
 * цены продажи из товара, итог до отправки и то, что документ уходит **одним** запросом, а
 * не по строке. Ошибка в строке не должна проводить ничего — это проверяется по остаткам.
 *
 * Usage: node scripts/src/check-bulk-movement-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9531);
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
const catalog = (await call("GET", "/api/products")).body ?? [];
const stock = catalog.filter((item) => item.productType === "stock" && item.currentStock >= 10);
const stockOf = async (productId) =>
  ((await call("GET", "/api/products")).body ?? []).find((item) => item.id === productId)
    ?.currentStock ?? null;
if (stock.length < 3) throw new Error("в демо-данных мало товаров с запасом");

const profile = mkdtempSync(path.join(tmpdir(), "dsh-bulk-ui-"));
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
  if (!wsUrl) throw new Error("нет подключения к браузеру");

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const requests = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params.request;
      if (/\/api\/movements/.test(request.url)) {
        requests.push({ url: request.url, method: request.method });
      }
    }
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
  const clickByText = async (text) => {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.textContent || '').trim() === ${JSON.stringify(text)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await sleep(1000);
    return clicked;
  };
  /** Выбирает товар в указанной строке через поиск в списке. */
  const chooseProduct = async (rowIndex, productName) => {
    const opened = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="bulk-movement-row"]')];
      const row = rows[${rowIndex}];
      const trigger = row?.querySelector('button[role="combobox"]');
      if (!trigger) return false;
      trigger.click();
      return true;
    })()`);
    if (!opened) return false;
    await sleep(600);
    // Пишем в поиск списка, чтобы не листать: список длинный, и позиции могут быть ниже.
    await evaluate(`(() => {
      const input = document.querySelector('input[placeholder^="Найти товар"]');
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(productName)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await sleep(600);
    const chosen = await evaluate(`(() => {
      const option = [...document.querySelectorAll('[role="option"]')]
        .find((node) => (node.textContent || '').includes(${JSON.stringify(productName)}));
      if (!option) return false;
      option.click();
      return true;
    })()`);
    await sleep(500);
    return chosen;
  };
  const fill = async (rowIndex, selector, value) => {
    const result = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('[data-testid="bulk-movement-row"]')];
      const input = rows[${rowIndex}]?.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const previous = input.value;
      setter.call(input, ${JSON.stringify(String(value))});
      if (input._valueTracker) input._valueTracker.setValue(previous);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    return result;
  };
  /** Заполняет поле вне строк документа: номер, дату, общую причину. */
  const fillGlobal = async (selector, value) => {
    const result = await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const previous = input.value;
      setter.call(input, ${JSON.stringify(String(value))});
      if (input._valueTracker) input._valueTracker.setValue(previous);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await sleep(250);
    return result;
  };
  const totals = async () =>
    evaluate(`(() => {
      const text = document.body.innerText.replace(/\\s+/g, ' ');
      return {
        positions: /Позиций: (\\d+)/.exec(text)?.[1] ?? null,
        quantity: /Всего: (\\d+)/.exec(text)?.[1] ?? null,
        money: /(Сумма закупки|Выручка): ([\\d\\s.,]+) ₽/.exec(text)?.[2] ?? null,
        kind: /(Сумма закупки|Выручка)/.exec(text)?.[1] ?? null,
      };
    })()`);

  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4000);

  console.log("=== 1. Кнопка и режимы ===");
  const hasButton = await evaluate(
    `[...document.querySelectorAll('button')].some((node) => (node.textContent || '').trim() === 'Массовая операция')`,
  );
  record("на странице операций есть «Массовая операция»", hasButton === true, String(hasButton));

  await clickByText("Массовая операция");
  const modes = await evaluate(`(() => ({
    title: /Массовая операция/.test(document.body.innerText),
    buttons: [...document.querySelectorAll('[data-testid^="bulk-kind-"]')].map((node) => (node.textContent || '').trim()),
    rows: document.querySelectorAll('[data-testid="bulk-movement-row"]').length,
    defaultPressed: document.querySelector('[data-testid="bulk-kind-receipt"]')?.getAttribute('aria-pressed'),
  }))()`);
  record(
    "в окне три режима: приход, продажа, списание",
    JSON.stringify(modes?.buttons) === JSON.stringify(["Приход", "Продажа", "Списание"]),
    JSON.stringify(modes?.buttons),
  );
  record("по умолчанию выбран приход", modes?.defaultPressed === "true", String(modes?.defaultPressed));
  record("строка одна", modes?.rows === 1, String(modes?.rows));

  console.log("=== 2. Поля зависят от режима ===");
  const receiptFields = await evaluate(`(() => {
    const row = document.querySelector('[data-testid="bulk-movement-row"]');
    return {
      purchase: Boolean(row?.querySelector('input[id^="bulk-price-"]')),
      markup: Boolean(row?.querySelector('input[id^="bulk-markup-"]')),
      sale: Boolean(row?.querySelector('input[id^="bulk-sale-price-"]')),
      lineReason: Boolean(row?.querySelector('input[id^="bulk-line-reason-"]')),
      orderNumber: Boolean(document.querySelector('#bulk-order')),
      arrivalDate: Boolean(document.querySelector('#bulk-date')),
    };
  })()`);
  record(
    "в приходе закупка, наценка, номер и дата",
    receiptFields?.purchase && receiptFields?.markup && receiptFields?.orderNumber && receiptFields?.arrivalDate,
    JSON.stringify(receiptFields),
  );

  await clickByText("Продажа");
  const expenseFields = await evaluate(`(() => {
    const row = document.querySelector('[data-testid="bulk-movement-row"]');
    return {
      sale: Boolean(row?.querySelector('input[id^="bulk-sale-price-"]')),
      purchase: Boolean(row?.querySelector('input[id^="bulk-price-"]')),
      orderNumber: Boolean(document.querySelector('#bulk-order')),
      amountLabel: /Выручка/.test(document.body.innerText),
    };
  })()`);
  record(
    "в продаже цена продажи, без закупки и без даты прихода",
    expenseFields?.sale && !expenseFields?.purchase && !expenseFields?.orderNumber,
    JSON.stringify(expenseFields),
  );
  record("итог продажи — выручка", expenseFields?.amountLabel === true, String(expenseFields?.amountLabel));

  await clickByText("Списание");
  const writeoffFields = await evaluate(`(() => {
    const row = document.querySelector('[data-testid="bulk-movement-row"]');
    return {
      lineReason: Boolean(row?.querySelector('input[id^="bulk-line-reason-"]')),
      sale: Boolean(row?.querySelector('input[id^="bulk-sale-price-"]')),
      purchase: Boolean(row?.querySelector('input[id^="bulk-price-"]')),
      reasonLabel: /Причина списания/.test(document.body.innerText),
      explainsCost: /Стоимость списания посчитается по партиям/.test(document.body.innerText),
    };
  })()`);
  record(
    "в списании своя причина строки и нет цен",
    writeoffFields?.lineReason && !writeoffFields?.sale && !writeoffFields?.purchase,
    JSON.stringify(writeoffFields),
  );
  record(
    "общая причина и честное объяснение про стоимость",
    writeoffFields?.reasonLabel && writeoffFields?.explainsCost,
    JSON.stringify(writeoffFields),
  );

  console.log("=== 3. Продажа: цена подставляется, итог считается ===");
  await clickByText("Продажа");
  await clickByText("Добавить строку");
  await chooseProduct(0, stock[0].name);
  await fill(0, 'input[id^="bulk-quantity-"]', 2);
  await chooseProduct(1, stock[1].name);
  await fill(1, 'input[id^="bulk-quantity-"]', 3);
  await sleep(500);

  const prices = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('[data-testid="bulk-movement-row"]')];
    return rows.map((row) => row.querySelector('input[id^="bulk-sale-price-"]')?.value ?? null);
  })()`);
  console.log("  цены в строках:", JSON.stringify(prices));
  record(
    "цена продажи подставлена из товара",
    prices.every((value) => value !== null && Number(value) > 0),
    JSON.stringify(prices),
  );

  const saleTotals = await totals();
  console.log("  итог:", JSON.stringify(saleTotals));
  record(
    "итог показывает две позиции и пять единиц",
    saleTotals?.positions === "2" && saleTotals?.quantity === "5",
    JSON.stringify(saleTotals),
  );
  record(
    "выручка совпадает с суммами строк",
    (() => {
      const expected = stock[0].salePrice * 2 + stock[1].salePrice * 3;
      const shown = Number(String(saleTotals?.money ?? "").replace(/\s/g, "").replace(",", "."));
      return Math.abs(shown - expected) < 0.02;
    })(),
    `на экране ${saleTotals?.money}, ожидалось ${stock[0].salePrice * 2 + stock[1].salePrice * 3}`,
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-bulk-movement-sale.png", shot.data);

  console.log("=== 4. Продажа уходит одним запросом ===");
  const beforeSale = new Map([
    [stock[0].id, await stockOf(stock[0].id)],
    [stock[1].id, await stockOf(stock[1].id)],
  ]);
  const mark = requests.length;
  await clickByText("Провести продажу");
  await sleep(2600);
  const sent = requests.slice(mark).filter((item) => item.url.includes("/bulk-expense"));
  record("ушёл один запрос на продажу", sent.length === 1, JSON.stringify(requests.slice(mark)));
  record(
    "отдельных одиночных операций не было",
    requests.slice(mark).filter((item) => /\/api\/movements$/.test(item.url)).length === 0,
    JSON.stringify(requests.slice(mark).map((item) => item.url)),
  );
  const afterSale = new Map([
    [stock[0].id, await stockOf(stock[0].id)],
    [stock[1].id, await stockOf(stock[1].id)],
  ]);
  record(
    "остатки уменьшились на количество из строк",
    afterSale.get(stock[0].id) === beforeSale.get(stock[0].id) - 2 &&
      afterSale.get(stock[1].id) === beforeSale.get(stock[1].id) - 3,
    JSON.stringify({
      первый: `${beforeSale.get(stock[0].id)} → ${afterSale.get(stock[0].id)}`,
      второй: `${beforeSale.get(stock[1].id)} → ${afterSale.get(stock[1].id)}`,
    }),
  );

  console.log("=== 5. Списание: своя причина и один запрос ===");
  await clickByText("Массовая операция");
  await clickByText("Списание");
  await chooseProduct(0, stock[0].name);
  await fill(0, 'input[id^="bulk-quantity-"]', 1);
  await fill(0, 'input[id^="bulk-line-reason-"]', "Брак");
  await fillGlobal("#bulk-reason", "Увядшие стебли");
  await clickByText("Добавить строку");
  await chooseProduct(1, stock[1].name);
  await fill(1, 'input[id^="bulk-quantity-"]', 1);
  const beforeWriteoff = new Map([
    [stock[0].id, await stockOf(stock[0].id)],
    [stock[1].id, await stockOf(stock[1].id)],
  ]);
  const markWriteoff = requests.length;
  await clickByText("Провести списание");
  await sleep(2600);
  record(
    "ушёл один запрос на списание",
    requests.slice(markWriteoff).filter((item) => item.url.includes("/bulk-writeoff")).length === 1,
    JSON.stringify(requests.slice(markWriteoff).map((item) => item.url)),
  );
  const afterWriteoff = new Map([
    [stock[0].id, await stockOf(stock[0].id)],
    [stock[1].id, await stockOf(stock[1].id)],
  ]);
  record(
    "оба товара списаны по единице",
    afterWriteoff.get(stock[0].id) === beforeWriteoff.get(stock[0].id) - 1 &&
      afterWriteoff.get(stock[1].id) === beforeWriteoff.get(stock[1].id) - 1,
    JSON.stringify({
      первый: `${beforeWriteoff.get(stock[0].id)} → ${afterWriteoff.get(stock[0].id)}`,
      второй: `${beforeWriteoff.get(stock[1].id)} → ${afterWriteoff.get(stock[1].id)}`,
    }),
  );

  const lastMovements = (await call("GET", "/api/movements?limit=2&type=writeoff")).body ?? [];
  record(
    "своя причина строки сохранилась, общая — у второй",
    lastMovements.some((item) => item.reason === "Брак") &&
      lastMovements.some((item) => item.reason === "Увядшие стебли"),
    JSON.stringify(lastMovements.map((item) => item.reason)),
  );

  console.log("=== 6. Ошибка в строке не проводит ничего ===");
  await clickByText("Массовая операция");
  await clickByText("Продажа");
  await chooseProduct(0, stock[2].name);
  await fill(0, 'input[id^="bulk-quantity-"]', 1);
  await clickByText("Добавить строку");
  await chooseProduct(1, stock[2].name);
  // Больше, чем есть на складе: сервер обязан отказать и не провести первую строку.
  await fill(1, 'input[id^="bulk-quantity-"]', (await stockOf(stock[2].id)) + 500);
  const beforeFail = await stockOf(stock[2].id);
  await clickByText("Провести продажу");
  await sleep(2500);
  const errorText = await evaluate(`(() => {
    const alert = document.querySelector('[role="alert"]');
    return (alert?.textContent || '').trim();
  })()`);
  record(
    "показана ошибка с номером строки",
    /Строка 2/.test(String(errorText)),
    JSON.stringify(errorText)?.slice(0, 200),
  );
  record(
    "первая строка не проведена — остаток не изменился",
    (await stockOf(stock[2].id)) === beforeFail,
    `${beforeFail} → ${await stockOf(stock[2].id)}`,
  );

  const errorShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-bulk-movement-error.png", errorShot.data);

  socket.close();
} catch (error) {
  record("проверка окна «Массовая операция»", false, String(error).slice(0, 400));
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
