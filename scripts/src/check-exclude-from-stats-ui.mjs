/**
 * Проверяет пометку «не в статистике» в интерфейсе.
 *
 * Смотрит то, что нельзя проверить по API: где галочка появляется, что она уходит
 * в запрос и как помеченная операция выглядит в истории.
 *
 * Usage: node scripts/src/check-exclude-from-stats-ui.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signInBrowser, signIn } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const port = Number(process.env.CDP_PORT ?? 9455);
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = mkdtempSync(path.join(tmpdir(), "dsh-exclude-ui-"));
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
  if (!wsUrl) throw new Error("Не удалось подключиться к Edge");

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
      if (request.method === "POST" && String(request.url).includes("/movements")) {
        requests.push(request.postData ?? "");
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
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 250));
    }
    return result.result?.value;
  };

  await signInBrowser(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(5000);

  const openDialog = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const opened = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => (node.textContent || '').trim() === 'Новая операция');
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (opened) {
        await sleep(1200);
        const hasDialog = await evaluate(
          `Boolean([...document.querySelectorAll('[role="dialog"]')]
             .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции')))`,
        );
        if (hasDialog) return true;
      }
      await sleep(400);
    }
    return false;
  };

  const pickType = async (label) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const picked = await evaluate(`(() => {
        const group = document.querySelector('[role="group"][aria-label="Тип операции"]');
        if (!group) return 'нет группы';
        const button = [...group.querySelectorAll('button')]
          .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
        if (!button) return 'нет кнопки';
        button.click();
        return 'выбрано';
      })()`);
      if (picked === "выбрано") {
        await sleep(700);
        return true;
      }
      await sleep(300);
    }
    return false;
  };

  const markerState = () =>
    evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      if (!dialog) return null;
      const box = dialog.querySelector('input[type="checkbox"][aria-label="Не учитывать операцию в статистике"], button[role="checkbox"][aria-label="Не учитывать операцию в статистике"]');
      const text = dialog.innerText.replace(/\\s+/g, ' ');
      return {
        present: Boolean(box),
        checked: box ? (box.getAttribute('aria-checked') === 'true' || box.checked === true) : null,
        explains: /в выручку, себестоимость и графики не попадёт/.test(text),
        height: box ? Math.round(box.getBoundingClientRect().height) : 0,
      };
    })()`);

  console.log("=== 1. Галочка появляется там, где нужна ===");
  const opened = await openDialog();
  record("окно операции открылось", opened === true, String(opened));
  const onReceipt = await markerState();
  record(
    "на приходе галочка есть",
    onReceipt?.present === true,
    JSON.stringify(onReceipt),
  );
  record("галочка объясняет, что произойдёт", onReceipt?.explains === true, JSON.stringify(onReceipt));
  record(
    "галочка не меньше 24 px — её видно на телефоне",
    (onReceipt?.height ?? 0) >= 24,
    `высота ${onReceipt?.height} px`,
  );

  await pickType("Продажа");
  const onSale = await markerState();
  record(
    "на продаже галочки нет: продажа — это всегда выручка",
    onSale?.present === false,
    JSON.stringify(onSale),
  );

  await pickType("Списание");
  const onWriteoff = await markerState();
  record("на списании галочка есть", onWriteoff?.present === true, JSON.stringify(onWriteoff));

  console.log("\n=== 2. Пометка уходит в запрос ===");
  // Берём товар склада: у букета списание требует выбрать сборку, и проверка
  // проверяла бы не пометку, а правило выбора сборки.
  await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    const trigger = dialog.querySelector('button[role="combobox"]');
    trigger.click();
    return 'открыт';
  })()`);
  await sleep(900);
  const picked = await evaluate(`(() => {
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((node) => /рулон|упак/.test(node.textContent || ''));
    if (!option) return { picked: false };
    const name = option.textContent.trim();
    option.click();
    return { picked: true, name };
  })()`);
  record("выбран товар склада", picked?.picked === true, JSON.stringify(picked));
  // Список Radix закрывается не всегда: с открытым списком нажатие до кнопки не
  // доходит, и запрос не уходит. Закрываем явно, если он ещё открыт.
  await sleep(700);
  const optionLeft = await evaluate(`document.querySelectorAll('[role="option"]').length`);
  if (optionLeft) {
    await evaluate(`(() => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return 'закрыт';
    })()`);
    await sleep(500);
  }
  record(
    "список товаров закрыт перед отправкой",
    (await evaluate(`document.querySelectorAll('[role="option"]').length`)) === 0,
    `открытых вариантов: ${await evaluate(`document.querySelectorAll('[role="option"]').length`)}`,
  );

  await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    const box = dialog.querySelector('input[type="checkbox"][aria-label="Не учитывать операцию в статистике"], button[role="checkbox"][aria-label="Не учитывать операцию в статистике"]');
    box.click();
    return 'нажата';
  })()`);
  await sleep(500);
  const afterClick = await markerState();
  record("галочка включается", afterClick?.checked === true, JSON.stringify(afterClick));

  requests.length = 0;
  await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    const button = [...dialog.querySelectorAll('button')]
      .find((node) => (node.textContent || '').trim() === 'Провести');
    button.click();
    return 'отправлено';
  })()`);
  await sleep(3000);
  const sent = requests.length ? JSON.parse(requests[requests.length - 1]) : null;
  console.log("  запрос:", JSON.stringify(sent));
  if (!requests.length) {
    const failedForm = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      if (!dialog) return { dialog: 'закрыт' };
      const comboboxes = [...dialog.querySelectorAll('button[role="combobox"]')]
        .map((node) => (node.textContent || '').trim());
      const selected = [...dialog.querySelectorAll('[data-state="checked"]')].length;
      return {
        comboboxes,
        selected,
        messages: [...dialog.querySelectorAll('[role="alert"], .text-destructive')]
          .map((node) => (node.textContent || '').trim())
          .filter(Boolean)
          .slice(0, 4),
        text: dialog.innerText.replace(/\\s+/g, ' ').slice(0, 300),
      };
    })()`);
    console.log("  форма:", JSON.stringify(failedForm));
  }
  record("запрос ушёл", requests.length > 0, `запросов ${requests.length}`);
  record(
    "в запросе стоит пометка «не в статистике»",
    sent?.excludeFromStats === true && sent?.type === "writeoff",
    JSON.stringify(sent),
  );
  record("окно закрылось после проведения", (await markerState()) === null, "окно всё ещё открыто");

  console.log("\n=== 3. В истории операция помечена ===");
  await sleep(1500);
  const history = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('table tbody tr')];
    const marked = rows.filter((row) => /не в статистике/.test(row.innerText || ''));
    return {
      rows: rows.length,
      marked: marked.length,
      firstMarked: marked[0]?.innerText?.replace(/\\s+/g, ' ').slice(0, 140) ?? '',
    };
  })()`);
  console.log("  история:", JSON.stringify(history));
  record("в истории есть помеченная операция", (history?.marked ?? 0) >= 1, JSON.stringify(history));
  record(
    "метка стоит рядом с причиной",
    (history?.firstMarked ?? "").includes("не в статистике") &&
      (history?.firstMarked ?? "").includes("Проверка") === false,
    JSON.stringify(history?.firstMarked),
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-exclude-from-stats.png", shot.data);

  console.log("\n=== 4. На телефоне помеченная карточка видна ===");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4500);
  const mobile = await evaluate(`(() => {
    const cards = [...document.querySelectorAll('div.md\\\\:hidden > div > div')];
    const marked = cards.filter((card) => /не в статистике/.test(card.innerText || ''));
    return {
      cards: cards.length,
      marked: marked.length,
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  console.log("  телефон:", JSON.stringify(mobile));
  record("на телефоне метка видна в карточке", (mobile?.marked ?? 0) >= 1, JSON.stringify(mobile));
  record("страница не едет вбок", (mobile?.overflowX ?? 1) <= 1, `overflowX ${mobile?.overflowX}`);

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-exclude-from-stats-mobile.png"),
    Buffer.from(mobileShot.data, "base64"),
  );

  socket.close();
} catch (error) {
  record("проверка пометки в интерфейсе", false, String(error).slice(0, 300));
} finally {
  browser.kill();
  await sleep(1000);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // уберёт система
  }
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
