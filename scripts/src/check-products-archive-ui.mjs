/**
 * Проверяет архив товаров в интерфейсе склада.
 *
 * Кнопка «Архив» должна показывать убранные товары с пометкой и возвращать их
 * в работу. Товары готовятся через API: интерфейс проверяется отдельно от
 * серверной логики, которая уже покрыта check-product-archive.mjs.
 *
 * Usage: node scripts/src/check-products-archive-ui.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn, signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));

const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const port = Number(process.env.CDP_PORT ?? 9403);
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const session = await signIn(api);
const call = async (method, requestPath, body) => {
  const response = await fetch(`${api}${requestPath}`, {
    method,
    headers: {
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 150);
  }
  return { status: response.status, body: parsed };
};

const NAME = "Архивный UI тест";

console.log("=== 1. Готовим архивный товар ===");
const created = await call("POST", "/api/products", {
  name: NAME,
  category: "Проверка",
  unit: "шт",
  purchasePrice: 100,
  markupPercent: 50,
  minimumStock: 0,
  shelfLifeDays: 0,
});
const productId = created.body?.id;
record("товар создан", created.status === 201 && productId > 0, `статус ${created.status}`);

await call("POST", "/api/movements", {
  productId,
  type: "receipt",
  quantity: 3,
  unitPrice: 100,
  reason: "Подготовка архива",
});
await call("POST", "/api/movements", {
  productId,
  type: "writeoff",
  quantity: 3,
  reason: "Обнуление перед архивом",
});
const archived = await call("DELETE", `/api/products/${productId}`);
record("товар отправлен в архив", archived.status === 204, `статус ${archived.status}`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-archive-ui-"));
const browser = spawn(
  edge,
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

const evaluate = async (cdp, expression) => {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 200));
  }
  return result.result?.value;
};

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
  if (!wsUrl) throw new Error("Не удалось подключиться к Edge");

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const parsed = JSON.parse(event.data);
    const resolve = pending.get(parsed.id);
    if (resolve) {
      pending.delete(parsed.id);
      resolve(parsed.result ?? parsed);
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

  await signInBrowser(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${ui}/products` });
  await sleep(5000);

  console.log("\n=== 2. Кнопка «Архив» на складе ===");
  const archiveButton = await evaluate(
    cdp,
    `(() => {
      const buttons = [...document.querySelectorAll('button')];
      const button = buttons.find((node) => /^Архив/.test((node.textContent || '').trim()));
      return button ? { text: button.textContent.trim() } : null;
    })()`,
  );
  record("кнопка «Архив» есть на складе", Boolean(archiveButton), JSON.stringify(archiveButton));
  record(
    "на кнопке виден счётчик архива",
    /\d/.test(archiveButton?.text ?? ""),
    JSON.stringify(archiveButton?.text),
  );

  const workingList = await evaluate(
    cdp,
    `document.body.innerText.includes(${JSON.stringify(NAME)})`,
  );
  record("архивный товар не мешает в рабочем списке", workingList === false, `найден: ${workingList}`);
  record(
    "кнопка корзины подписана как перенос в архив",
    await evaluate(
      cdp,
      `[...document.querySelectorAll('button[aria-label]')].some((node) => (node.getAttribute('aria-label') || '').startsWith('Убрать в архив'))`,
    ) === true,
    "нет ни одной кнопки «Убрать в архив»",
  );

  console.log("\n=== 3. Переход в архив ===");
  await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => /^Архив/.test((node.textContent || '').trim()));
      button.click();
      return 'нажата';
    })()`,
  );
  await sleep(1500);

  const archiveView = await evaluate(
    cdp,
    `(() => {
      const text = document.body.innerText;
      return {
        hasProduct: text.includes(${JSON.stringify(NAME)}),
        badge: text.includes('в архиве'),
        restoreButtons: [...document.querySelectorAll('button[aria-label]')]
          .filter((node) => (node.getAttribute('aria-label') || '').startsWith('Вернуть из архива')).length,
      };
    })()`,
  );
  console.log("  вид архива:", JSON.stringify(archiveView));
  record("архивный товар виден в архиве", archiveView?.hasProduct === true, JSON.stringify(archiveView));
  record("у архивного товара есть пометка «в архиве»", archiveView?.badge === true, JSON.stringify(archiveView));
  record("есть кнопка возврата из архива", archiveView?.restoreButtons > 0, `кнопок: ${archiveView?.restoreButtons}`);
  record(
    "в архиве нет кнопок переноса в архив",
    await evaluate(
      cdp,
      `[...document.querySelectorAll('button[aria-label]')].some((node) => (node.getAttribute('aria-label') || '').startsWith('Убрать в архив'))`,
    ) === false,
    "в архиве всё ещё есть кнопка «Убрать в архив»",
  );

  // Снимок для глазной проверки: вёрстку счётчиков и пометок видно только так.
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotPath = path.resolve(here, "..", "..", "screenshots", "check-archive-view.png");
  writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
  console.log(`  снимок: ${shotPath}`);

  console.log("\n=== 4. Возврат товара из архива ===");
  await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button[aria-label]')]
        .find((node) => (node.getAttribute('aria-label') || '') === 'Вернуть из архива ' + ${JSON.stringify(NAME)});
      if (!button) return 'нет кнопки';
      button.click();
      return 'нажата';
    })()`,
  );
  await sleep(2500);

  const afterRestore = await evaluate(
    cdp,
    `(() => {
      const text = document.body.innerText;
      return { stillInArchive: text.includes(${JSON.stringify(NAME)}) };
    })()`,
  );
  record("после возврата товар уходит из архива", afterRestore?.stillInArchive === false, JSON.stringify(afterRestore));

  const backToWork = await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => /^Обычный склад/.test((node.textContent || '').trim()));
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  await sleep(1800);
  const workingView = await evaluate(
    cdp,
    `(() => {
      const text = document.body.innerText;
      return { hasProduct: text.includes(${JSON.stringify(NAME)}) };
    })()`,
  );
  record("товар вернулся в рабочий список", backToWork === true && workingView?.hasProduct === true, JSON.stringify(workingView));

  console.log("\n=== 5. Архив на телефоне ===");
  // На телефоне тот же экран показывает карточки вместо таблицы: кнопка «Архив»
  // и возврат должны быть такими же доступными, как остальные действия.
  await call("DELETE", `/api/products/${productId}`);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/products` });
  await sleep(4000);

  const mobileArchive = await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => /^Архив/.test((node.textContent || '').trim()));
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { height: Math.round(box.height), text: button.textContent.trim() };
    })()`,
  );
  record("кнопка «Архив» есть на телефоне", Boolean(mobileArchive), JSON.stringify(mobileArchive));
  record(
    "кнопка не ниже 44 px",
    (mobileArchive?.height ?? 0) >= 44,
    `высота ${mobileArchive?.height} px`,
  );

  await evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => /^Архив/.test((node.textContent || '').trim()));
      button.click();
      return 'нажата';
    })()`,
  );
  await sleep(1800);

  const mobileView = await evaluate(
    cdp,
    `(() => {
      const text = document.body.innerText;
      const restore = [...document.querySelectorAll('button[aria-label]')]
        .filter((node) => (node.getAttribute('aria-label') || '').startsWith('Вернуть из архива'));
      const visible = restore.filter((node) => node.offsetParent !== null);
      return {
        hasProduct: text.includes(${JSON.stringify(NAME)}),
        badge: text.includes('в архиве'),
        restoreVisible: visible.length,
        restoreHeight: visible[0] ? Math.round(visible[0].getBoundingClientRect().height) : 0,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`,
  );
  console.log("  вид архива на телефоне:", JSON.stringify(mobileView));
  record("на телефоне архивный товар виден", mobileView?.hasProduct === true, JSON.stringify(mobileView));
  record("на телефоне есть пометка «в архиве»", mobileView?.badge === true, JSON.stringify(mobileView));
  record("на телефоне есть кнопка возврата", mobileView?.restoreVisible > 0, JSON.stringify(mobileView));
  record(
    "кнопка возврата не ниже 44 px",
    (mobileView?.restoreHeight ?? 0) >= 44,
    `высота ${mobileView?.restoreHeight} px`,
  );
  record("экран не едет вбок", (mobileView?.overflowX ?? 1) <= 0, `overflowX ${mobileView?.overflowX}`);

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const mobileShotPath = path.resolve(here, "..", "..", "screenshots", "check-archive-mobile.png");
  writeFileSync(mobileShotPath, Buffer.from(mobileShot.data, "base64"));
  console.log(`  снимок: ${mobileShotPath}`);

  socket.close();
} catch (error) {
  record("проверка архива в интерфейсе", false, String(error).slice(0, 200));
} finally {
  browser.kill();
  await sleep(1000);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // уберёт система
  }
}

// Убираем за собой: списываем остаток и уводим товар в архив.
await call("DELETE", `/api/products/${productId}`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
