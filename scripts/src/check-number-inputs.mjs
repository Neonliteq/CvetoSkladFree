/**
 * Проверяет, что у числовых полей нет стрелок.
 *
 * Стрелки — это псевдоэлементы браузера, в DOM их не видно. Поэтому проверка
 * смотрит вычисленный `appearance` у каждого поля и дополнительно убеждается,
 * что при возврате стрелок стилем вид поля меняется: иначе проверка молча
 * проходила бы на пустом месте.
 *
 * Usage: node scripts/src/check-number-inputs.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const port = Number(process.env.CDP_PORT ?? 9420);
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-numbers-"));
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

const measure = `(() => {
  const box = document.querySelector('[role="dialog"]') ?? document.body;
  const fields = [...box.querySelectorAll('input[type="number"]')]
    .filter((node) => node.offsetParent !== null);
  if (!fields.length) return { fields: [] };
  const read = () => fields.map((node) => ({
    label: node.getAttribute('aria-label') || node.getAttribute('name') || 'поле количества',
    appearance: getComputedStyle(node).appearance,
  }));
  const without = read();
  const style = document.createElement('style');
  style.textContent = 'input[type="number"]{appearance:auto !important;-moz-appearance:auto !important}' +
    'input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button' +
    '{-webkit-appearance:auto !important;appearance:auto !important;margin:0 !important}';
  document.head.appendChild(style);
  const withSpinners = read();
  style.remove();
  return { fields: without, withSpinners };
})()`;

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
  const evaluate = async (expression) => {
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

  await signInBrowser(cdp);
  await cdp.send("Page.enable");

  const total = { fields: 0, ok: 0 };

  /** Открывает окно, проверяет поля внутри и закрывает его. */
  const checkWindow = async (title, trigger, waitMs = 1500, shotName = null) => {
    await evaluate(trigger);
    await sleep(waitMs);
    const measured = await evaluate(measure);
    const fields = measured?.fields ?? [];
    if (!fields.length) {
      record(`${title}: есть числовые поля`, false, "поля не найдены");
      return;
    }
    total.fields += fields.length;
    const plain = fields.filter((field) => field.appearance === "textfield");
    total.ok += plain.length;
    record(
      `${title}: полей ${fields.length}, все без стрелок`,
      plain.length === fields.length,
      fields.map((field) => `${field.label}=${field.appearance}`).join(", "),
    );
    // Возврат стрелок стилем должен менять вид поля: иначе измерять нечего.
    const restored = (measured?.withSpinners ?? []).filter(
      (field) => field.appearance !== "textfield",
    );
    record(
      `${title}: проверка замечает возврат стрелок`,
      restored.length === fields.length,
      (measured?.withSpinners ?? []).map((field) => field.appearance).join(", "),
    );
    if (shotName) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      const shotPath = path.resolve(here, "..", "..", "screenshots", `check-number-${shotName}.png`);
      writeFileSync(shotPath, Buffer.from(shot.data, "base64"));
      console.log(`  снимок: ${shotPath}`);
    }
    await evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      const button = [...(dialog?.querySelectorAll('button') ?? [])]
        .find((node) => (node.textContent || '').includes('Закрыть'));
      if (button) button.click();
      return 'закрыто';
    })()`);
    await sleep(800);
  };

  console.log("=== 1. Склад: товар и его правка ===");
  await cdp.send("Page.navigate", { url: `${ui}/products` });
  await sleep(4500);
  await checkWindow(
    "Новый товар",
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.textContent || '').includes('Добавить товар'));
      button.click();
      return 'открыт';
    })()`,
  );
  await checkWindow(
    "Правка товара",
    `(() => {
      const button = [...document.querySelectorAll('button[aria-label^="Редактировать"]')]
        .find((node) => node.offsetParent !== null);
      button.click();
      return 'открыт';
    })()`,
  );

  console.log("\n=== 2. Приходы товара: правка прихода ===");
  await evaluate(`(() => {
    const row = document.querySelector('table tbody tr');
    row.click();
    return 'открыт';
  })()`);
  await sleep(2500);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button[aria-label^="Изменить приход"], button[aria-label^="Редактировать приход"]')]
      .find((node) => node.offsetParent !== null);
    if (button) button.click();
    return 'открыт';
  })()`);
  await sleep(1500);
  const receipts = await evaluate(measure);
  const receiptFields = (receipts?.fields ?? []).filter(
    (field) => field.appearance === "textfield",
  );
  record(
    "Правка прихода: числовые поля без стрелок",
    (receipts?.fields ?? []).length > 0 && receiptFields.length === receipts.fields.length,
    (receipts?.fields ?? []).map((field) => `${field.label}=${field.appearance}`).join(", "),
  );
  total.fields += (receipts?.fields ?? []).length;
  total.ok += receiptFields.length;

  console.log("\n=== 3. Букеты ===");
  await cdp.send("Page.navigate", { url: `${ui}/bouquets` });
  await sleep(4000);
  await checkWindow(
    "Новый рецепт",
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.textContent || '').includes('Собрать рецепт'));
      button.click();
      return 'открыт';
    })()`,
  );
  await checkWindow(
    "Правка рецепта",
    `(() => {
      const button = [...document.querySelectorAll('button[aria-label^="Редактировать"]')]
        .find((node) => node.offsetParent !== null);
      button.click();
      return 'открыт';
    })()`,
  );
  await checkWindow(
    "Производство букета",
    `(() => {
      const button = [...document.querySelectorAll('button[aria-label^="Собрать "]')]
        .find((node) => node.offsetParent !== null);
      button.click();
      return 'открыт';
    })()`,
    1500,
    "produce",
  );

  console.log("\n=== 4. Операции ===");
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4000);
  await checkWindow(
    "Новая операция",
    `(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.textContent || '').trim() === 'Новая операция');
      button.click();
      return 'открыт';
    })()`,
  );

  console.log(`\nвсего числовых полей проверено: ${total.fields}`);

  console.log("\n=== 5. Правило общее для всего приложения ===");
  // Окна накладной и черновика снимка открыть без распознавания фото нельзя.
  // Но правило одно на всё приложение, поэтому проверяем его на пробном поле,
  // которого нет ни в одном окне: если стиль применился к нему, он применится и
  // к любому другому числовому полю, включая накладную.
  const globalRule = await evaluate(`(() => {
    const probe = document.createElement('input');
    probe.type = 'number';
    probe.style.position = 'fixed';
    probe.style.top = '-100px';
    document.body.appendChild(probe);
    const before = getComputedStyle(probe).appearance;
    const style = document.createElement('style');
    style.textContent = 'input[type="number"]{appearance:auto !important;-moz-appearance:auto !important}' +
      'input[type="number"]::-webkit-inner-spin-button,input[type="number"]::-webkit-outer-spin-button' +
      '{-webkit-appearance:auto !important;appearance:auto !important;margin:0 !important}';
    document.head.appendChild(style);
    const after = getComputedStyle(probe).appearance;
    style.remove();
    probe.remove();
    return { before, after, changed: before !== after };
  })()`);
  console.log("  пробное поле:", JSON.stringify(globalRule));
  record(
    "числовое поле вне окна тоже без стрелок",
    globalRule?.before === "textfield",
    JSON.stringify(globalRule),
  );
  record(
    "проверка замечает возврат стрелок",
    globalRule?.changed === true,
    JSON.stringify(globalRule),
  );

  socket.close();
} catch (error) {
  record("проверка числовых полей", false, String(error).slice(0, 200));
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
