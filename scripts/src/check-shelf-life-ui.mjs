/**
 * «Без срока годности» в формах товара.
 *
 * Проверяется то, что видит человек: галочка есть, при включении поле дней выключается и
 * показывает 0, при выключении возвращается 14. И главное — что при сохранении в API уходит
 * `shelfLifeDays: 0`, а не число из выключенного поля.
 *
 * Usage: node scripts/src/check-shelf-life-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9631);
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

// Товар без срока, созданный заранее: нужен, чтобы проверить окно правки.
const stamp = Date.now();
const existingName = `Упаковка без срока ${stamp}`;
const created = await call("POST", "/api/products", {
  name: existingName,
  category: "Упаковка",
  unit: "упак.",
  minimumStock: 0,
  shelfLifeDays: 0,
  aliases: [],
});
if (created.status !== 201) throw new Error(`не удалось создать товар: ${JSON.stringify(created.body)}`);

const profile = mkdtempSync(path.join(tmpdir(), "dsh-shelf-ui-"));
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
  const waitFor = async (expression, timeoutMs = 20000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    throw new Error(`не дождались: ${expression}`);
  };
  /** Состояние галочки «Без срока годности» и поля дней в открытом окне. */
  const formState = () =>
    evaluate(`(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return null;
      const checkbox = dialog.querySelector('[aria-label="Без срока годности"]');
      // Поле ищем по признаку из разметки: раньше проверка брала последний числовой input и
      // попадала в «Мин. остаток», из-за чего все утверждения про срок были ложными.
      const field = dialog.querySelector('#shelf-life-days');
      return {
        hasCheckbox: Boolean(checkbox),
        checked: checkbox?.getAttribute('data-state') === 'checked' || checkbox?.getAttribute('aria-checked') === 'true',
        daysDisabled: field ? field.disabled : null,
        daysValue: field ? field.value : null,
        hint: /без срока/i.test(dialog.innerText),
      };
    })()`);

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/products` });
  await waitFor(`document.body.innerText.includes('Склад')`);
  await sleep(1500);

  console.log("=== 1. Окно создания ===");
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === 'Добавить товар');
    if (button) button.click();
    return Boolean(button);
  })()`);
  await sleep(1000);
  const initial = await formState();
  console.log("  окно:", JSON.stringify(initial));
  record("галочка «Без срока годности» есть", initial?.hasCheckbox === true, JSON.stringify(initial));
  record("по умолчанию не отмечена", initial?.checked === false, String(initial?.checked));
  record(
    "поле дней активно и заполнено 14",
    initial?.daysDisabled === false && initial?.daysValue === "14",
    JSON.stringify({ disabled: initial?.daysDisabled, value: initial?.daysValue }),
  );

  await evaluate(`(() => {
    const box = document.querySelector('[role="dialog"] [aria-label="Без срока годности"]');
    if (!box) return false;
    box.click();
    return true;
  })()`);
  await sleep(700);
  const off = await formState();
  console.log("  после включения:", JSON.stringify(off));
  record("после включения поле дней выключено", off?.daysDisabled === true, String(off?.daysDisabled));
  record("поле показывает 0", off?.daysValue === "0", String(off?.daysValue));

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-shelf-life-dialog.png", shot.data);

  await evaluate(`(() => {
    const box = document.querySelector('[role="dialog"] [aria-label="Без срока годности"]');
    if (!box) return false;
    box.click();
    return true;
  })()`);
  await sleep(700);
  const backOn = await formState();
  record(
    "после выключения поле активно и снова 14",
    backOn?.daysDisabled === false && backOn?.daysValue === "14",
    JSON.stringify({ disabled: backOn?.daysDisabled, value: backOn?.daysValue }),
  );

  // Закрываем окно создания — дальше проверяем правку.
  await evaluate(`document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(800);

  console.log("=== 2. Окно правки товара без срока ===");
  const opened = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('tbody tr')];
    const row = rows.find((node) => (node.textContent || '').includes(${JSON.stringify(existingName)}));
    if (!row) return { found: false };
    const button = row.querySelector('button[aria-label^="Редактировать"]');
    if (!button) return { found: true, button: false };
    button.click();
    return { found: true, button: true };
  })()`);
  await sleep(1200);
  const editState = await formState();
  console.log("  окно правки:", JSON.stringify(editState));
  record("строка товара найдена", opened?.found === true, JSON.stringify(opened));
  record("галочка отмечена у товара без срока", editState?.checked === true, JSON.stringify(editState));
  record("поле дней выключено и показывает 0", editState?.daysDisabled === true && editState?.daysValue === "0", JSON.stringify({ disabled: editState?.daysDisabled, value: editState?.daysValue }));

  const editShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-shelf-life-edit.png", editShot.data);

  console.log("=== 3. Сохранение оставляет срок нулевым ===");
  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const button = [...(dialog?.querySelectorAll('button') ?? [])].find((node) => /Сохранить/i.test(node.textContent || ''));
    if (button) button.click();
    return Boolean(button);
  })()`);
  await sleep(2500);
  const refreshed = (await call("GET", "/api/products")).body?.find((item) => item.name === existingName);
  record(
    "в API у товара по-прежнему 0 дней",
    refreshed?.shelfLifeDays === 0,
    `shelfLifeDays ${refreshed?.shelfLifeDays}`,
  );

  socket.close();
} catch (error) {
  record("проверка «без срока годности»", false, String(error).slice(0, 400));
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
