/**
 * Проверяет поиск товара в выборе — в одиночной операции и в накладной.
 *
 * Смотрит то, чего не видно по коду: что в списке действительно есть поле ввода, что
 * набор сужает список, что товар находится по **псевдониму** (магазин называет товары
 * по-своему — «роза красная», а в каталоге «Роза Эквадор красная (Freedom)»), и что
 * выбор после поиска подставляется в форму.
 *
 * Usage: node scripts/src/check-product-picker-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9503);
seedDatabase();
ensureScreenshotsDir();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const session = await signIn(api);
const catalog = await fetch(`${api}/api/products`, {
  headers: { cookie: session.cookieHeader, origin: new URL(api).origin },
}).then((response) => response.json());
/**
 * Товар с псевдонимом, который **не входит в название**.
 *
 * Иначе проверка «находится по псевдониму» ничего не доказывает: «крафт» есть в названии
 * «Бумага крафт», и поиск нашёл бы товар по одному названию. Нужен псевдоним, которого в
 * названии нет, — «лизиантус» для «Эустома розовая».
 */
const aliasPair = catalog
  .filter((item) => (item.aliases ?? []).length > 0)
  .flatMap((item) =>
    item.aliases.map((alias) => ({ product: item, alias })),
  )
  .find(({ product, alias }) => !product.name.toLocaleLowerCase("ru").includes(alias.toLocaleLowerCase("ru")));
if (!aliasPair) throw new Error("в демо-данных нет товара с псевдонимом, отличным от названия");
const { product: withAlias, alias } = aliasPair;
console.log(`товар для проверки: ${withAlias.name}, псевдоним «${alias}» (в названии его нет)`);
const totalStock = catalog.filter((item) => item.productType === "stock").length;
const totalBouquets = catalog.filter((item) => item.productType === "bouquet").length;
console.log(`в каталоге: складских ${totalStock}, букетов ${totalBouquets}`);

const profile = mkdtempSync(path.join(tmpdir(), "dsh-picker-ui-"));
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
  /** Печатает в поле поиска внутри выпадающего списка. */
  const typeInSearch = async (text) => {
    const typed = await evaluate(`(() => {
      const input = document.querySelector('input[placeholder^="Найти товар"]');
      if (!input) return 'нет поля поиска';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const previous = input.value;
      setter.call(input, ${JSON.stringify(text)});
      const tracker = input._valueTracker;
      if (tracker) tracker.setValue(previous);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return input.value;
    })()`);
    await sleep(600);
    return typed;
  };
  const options = async () =>
    evaluate(
      `[...document.querySelectorAll('[role="option"]')].map((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim())`,
    );

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4000);

  console.log("=== 1. Одиночная операция: поле поиска есть ===");
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === 'Новая операция');
    if (button) button.click();
    return Boolean(button);
  })()`);
  await sleep(1200);
  await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const trigger = dialog?.querySelector('button[role="combobox"]');
    if (trigger) trigger.click();
    return Boolean(trigger);
  })()`);
  await sleep(800);

  const searchField = await evaluate(`(() => {
    const input = document.querySelector('input[placeholder^="Найти товар"]');
    return { present: Boolean(input), placeholder: input?.getAttribute('placeholder') ?? null, focused: document.activeElement === input };
  })()`);
  record("в списке есть поле поиска", searchField?.present === true, JSON.stringify(searchField));
  record("поле поиска получает фокус сразу", searchField?.focused === true, "фокус не в поле — придётся кликать");

  const all = await options();
  console.log(`  вариантов без поиска: ${all.length}`);
  record(
    // В одиночной операции список полный: букет тоже выбирают — его продают и списывают.
    // Только в накладной он ограничен складом, и это проверяется отдельно.
    "без поиска виден весь каталог",
    all.length === catalog.length,
    `${all.length} против ${catalog.length}`,
  );

  console.log("=== 2. Набор сужает список ===");
  const typedName = await typeInSearch("роза");
  const byName = await options();
  console.log(`  по «роза»: ${JSON.stringify(byName)}`);
  record("набор принят полем", typedName === "роза", String(typedName));
  record(
    "список сузился и все варианты содержат запрос",
    byName.length > 0 && byName.length < all.length && byName.every((text) => /роза/i.test(text)),
    JSON.stringify(byName)?.slice(0, 250),
  );

  // Снимок открытого поиска: именно это видит кладовщик, когда набирает название.
  const searchShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-product-picker-search.png", searchShot.data);

  console.log("=== 3. Поиск по псевдониму ===");
  await typeInSearch(alias);
  const byAlias = await options();
  console.log(`  по псевдониму «${alias}»: ${JSON.stringify(byAlias)}`);
  record(
    "товар находится по псевдониму",
    byAlias.some((text) => text.includes(withAlias.name)),
    JSON.stringify(byAlias)?.slice(0, 250),
  );

  console.log("=== 4. Ничего не найдено ===");
  await typeInSearch("ааааа-нет-такого");
  const empty = await evaluate(`(() => {
    const text = document.body.innerText;
    return { hasEmpty: /Товар не найден/.test(text), options: document.querySelectorAll('[role="option"]').length };
  })()`);
  record("показано «товар не найден»", empty?.hasEmpty === true && empty?.options === 0, JSON.stringify(empty));

  console.log("=== 5. Выбор после поиска подставляется в форму ===");
  await typeInSearch(alias);
  const picked = await evaluate(`(() => {
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((node) => (node.textContent || '').includes(${JSON.stringify(withAlias.name)}));
    if (!option) return { picked: false };
    option.click();
    return { picked: true };
  })()`);
  await sleep(900);
  const triggerText = await evaluate(`(() => {
    const dialog = document.querySelector('[role="dialog"]');
    const trigger = dialog?.querySelector('button[role="combobox"]');
    return (trigger?.textContent || '').replace(/\\s+/g, ' ').trim();
  })()`);
  record("вариант выбран", picked?.picked === true, JSON.stringify(picked));
  record(
    "в форме видно выбранный товар",
    String(triggerText).includes(withAlias.name),
    String(triggerText),
  );
  const listClosed = await evaluate(`document.querySelectorAll('[role="option"]').length`);
  record("список закрылся после выбора", listClosed === 0, `осталось вариантов: ${listClosed}`);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-product-picker.png", shot.data);

  console.log("=== 6. Накладная: поиск в строке и только склад ===");
  await evaluate(`(() => {
    const close = document.querySelector('[role="dialog"] button[aria-label="Закрыть"], [role="dialog"] button:has(svg.lucide-x)');
    if (close) close.click();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await sleep(700);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === 'Массовая операция');
    if (button) button.click();
    return Boolean(button);
  })()`);
  await sleep(1200);
  await evaluate(`(() => {
    const row = document.querySelector('[data-testid="bulk-movement-row"]');
    const trigger = row?.querySelector('button[role="combobox"]');
    if (trigger) trigger.click();
    return Boolean(trigger);
  })()`);
  await sleep(800);
  await typeInSearch("роза");
  const bulkOptions = await options();
  console.log(`  массовая операция, по «роза»: ${JSON.stringify(bulkOptions)}`);
  record(
    "в массовой операции поиск тоже работает",
    bulkOptions.length > 0 && bulkOptions.every((text) => /роза/i.test(text)),
    JSON.stringify(bulkOptions)?.slice(0, 250),
  );
  record(
    "в накладной предлагаются только складские товары",
    bulkOptions.every((text) => !/^Букет/.test(text)),
    JSON.stringify(bulkOptions)?.slice(0, 200),
  );

  socket.close();
} catch (error) {
  record("проверка поиска товара", false, String(error).slice(0, 400));
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
