/**
 * Сводка: проблемы первыми, просрочка отдельно от истекающих, числа и действие по ним.
 *
 * Ожидания берутся из ответа `/api/dashboard`, а не из разметки: иначе проверка сверяла бы
 * страницу с самой собой и проходила бы при любом содержимом.
 *
 * Usage: node scripts/src/check-dashboard-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9561);
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
const soon = dashboard.expiring.filter((batch) => batch.daysLeft >= 0);
/** Убирает неразрывные пробелы: Intl ставит их между разрядами и перед «₽». */
const normalize = (value) => String(value ?? "").replace(/[\u00a0\u202f]/g, " ");

// Тот же формат, что в приложении: рубли без копеек (`formatCurrency` в lib/utils).
const money = (value) =>
  new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
console.log(
  `данные: просрочено ${expired.length}, истекает ${soon.length}, дефицит ${dashboard.lowStock.length}, стоимость ${money(dashboard.inventoryValue)}`,
);

// Итог по просрочке — в тех же единицах, что показывает карточка: суммы количеств.
const expiredByProduct = new Map();
for (const batch of expired) {
  expiredByProduct.set(batch.productId, (expiredByProduct.get(batch.productId) ?? 0) + batch.quantity);
}

const profile = mkdtempSync(path.join(tmpdir(), "dsh-dashboard-"));
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

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/` });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = await evaluate(
      `getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)' && document.body.innerText.includes('Сводка')`,
    );
    if (ready) break;
    await sleep(250);
  }
  await sleep(1200);

  console.log("=== 1. Проблемы идут первыми ===");
  const order = await evaluate(`(() => {
    const text = document.body.innerText;
    // Позицию берём у первого элемента в порядке документа, чей текст начинается с подписи:
    // это контейнер блока, и его верх — то, что видит человек. Подпись «Товаров» на экране
    // показана заглавными через CSS, а в разметке остаётся обычной — сравниваем как есть.
    const position = (needle) => {
      const node = [...document.querySelectorAll('h1, h2, h3, [data-slot="card"], .rounded-xl, p, span, div')]
        .find((item) => (item.textContent || '').replace(/\\s+/g, ' ').trim().startsWith(needle));
      return node ? Math.round(node.getBoundingClientRect().top) : null;
    };
    return {
      problems: Math.min(...[position('Просрочено'), position('Заканчивается'), position('Всё в порядке')].filter((value) => value !== null)),
      metrics: position('Товаров'),
      operations: position('Последние операции'),
      text,
    };
  })()`);
  console.log(`  позиции по вертикали: проблемы ${order?.problems}, показатели ${order?.metrics}, операции ${order?.operations}`);
  record(
    "блок проблем выше показателей склада",
    order?.problems !== null && order?.metrics !== null && order.problems < order.metrics,
    JSON.stringify({ problems: order?.problems, metrics: order?.metrics }),
  );
  record(
    "последние операции ниже показателей",
    order?.operations !== null && order.operations > order.metrics,
    JSON.stringify({ metrics: order?.metrics, operations: order?.operations }),
  );

  console.log("=== 2. Просрочка отдельно от истекающих ===");
  if (expired.length > 0) {
    const expiredBlock = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('[data-slot="card"]')];
      const card = cards.find((node) => (node.innerText || '').trim().startsWith('Просрочено'));
      if (!card) return null;
      return {
        text: (card.innerText || '').replace(/\\s+/g, ' ').trim(),
        badges: [...card.querySelectorAll('span,div')]
          .map((node) => (node.textContent || '').trim())
          .filter((text) => /просрочено \\d+ дн\\./.test(text)),
      };
    })()`);
    console.log("  карточка просрочки:", JSON.stringify(expiredBlock)?.slice(0, 200));
    record(
      "есть отдельная карточка «Просрочено»",
      expiredBlock !== null,
      "карточка не найдена",
    );
    record(
      "просрочка подписана словами, а не отрицательным числом",
      /просрочено \d+ дн\./.test(String(expiredBlock?.text)) && !/Осталось -\d/.test(String(order?.text)),
      String(expiredBlock?.text)?.slice(0, 160),
    );
    record(
      "количество партий и единиц совпадает с данными",
      String(expiredBlock?.text ?? "").includes(`${expired.length}`) &&
        String(expiredBlock?.text ?? "").includes(`${expired.reduce((sum, batch) => sum + batch.quantity, 0)}`),
      `в API: ${expired.length} партий, ${expired.reduce((sum, batch) => sum + batch.quantity, 0)} ед.`,
    );
  } else {
    record("есть отдельная карточка «Просрочено»", false, "в демо-данных нет просроченных партий");
  }

  record(
    "«Истекает скоро» считает только непросроченные",
    String(order?.text ?? "").includes(`${soon.length}`),
    `в API непросроченных ${soon.length}`,
  );

  console.log("=== 3. Числа и стоимость склада ===");
  record(
    "крупные числа с разделителем разрядов",
    normalize(order?.text).includes(normalize(dashboard.totalUnits.toLocaleString("ru-RU"))),
    `ожидалось ${dashboard.totalUnits.toLocaleString("ru-RU")}`,
  );
  record(
    "стоимость склада показана и совпадает с API",
    normalize(order?.text).includes(normalize(money(dashboard.inventoryValue))),
    `ожидалось ${money(dashboard.inventoryValue)}`,
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-dashboard.png", shot.data);

  console.log("=== 4. Кнопка открывает списание с готовыми строками ===");
  if (expired.length > 0) {
    const opened = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.textContent || '').trim() === 'Списать просроченное');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await sleep(1400);
    const dialog = await evaluate(`(() => {
      const panel = document.querySelector('[role="dialog"]');
      if (!panel) return null;
      const rows = [...panel.querySelectorAll('[data-testid="bulk-movement-row"]')];
      return {
        title: (panel.querySelector('h2')?.textContent || '').trim(),
        kindWriteoff: panel.querySelector('[data-testid="bulk-kind-writeoff"]')?.getAttribute('aria-pressed'),
        rows: rows.length,
        products: rows.map((row) => (row.querySelector('button[role="combobox"]')?.textContent || '').replace(/\\s+/g, ' ').trim()),
        quantities: rows.map((row) => row.querySelector('input[id^="bulk-quantity-"]')?.value),
        reason: panel.querySelector('#bulk-reason')?.value ?? null,
      };
    })()`);
    console.log("  окно:", JSON.stringify(dialog)?.slice(0, 320));
    record("окно открылось", opened === true && dialog !== null, JSON.stringify({ opened, title: dialog?.title }));
    record(
      "выбран вид «Списание»",
      dialog?.kindWriteoff === "true",
      String(dialog?.kindWriteoff),
    );
    record(
      "строки заполнены по количеству просроченных товаров",
      dialog?.rows === expiredByProduct.size,
      `строк ${dialog?.rows}, товаров с просрочкой ${expiredByProduct.size}`,
    );
    record(
      "количество в строках совпадает с просрочкой",
      JSON.stringify(
        (dialog?.quantities ?? []).map(Number).sort((a, b) => a - b),
      ) === JSON.stringify([...expiredByProduct.values()].sort((a, b) => a - b)),
      `в окне ${JSON.stringify(dialog?.quantities)}, ожидалось ${JSON.stringify([...expiredByProduct.values()])}`,
    );
    record(
      "причина подставлена",
      dialog?.reason === "Просроченный товар",
      String(dialog?.reason),
    );
    const dialogShot = await cdp.send("Page.captureScreenshot", { format: "png" });
    saveScreenshot("check-dashboard-writeoff.png", dialogShot.data);
  } else {
    record("кнопка «Списать просроченное» есть", false, "нет просроченных партий в демо-данных");
  }

  socket.close();
} catch (error) {
  record("проверка сводки", false, String(error).slice(0, 400));
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
