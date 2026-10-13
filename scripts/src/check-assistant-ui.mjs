/**
 * Drives composite commands through the real assistant UI in headless Edge.
 *
 * The server already breaks a composite command down before writing anything;
 * this check covers the part only the interface can get wrong:
 *   1) a command with two definite positions shows a preview card and writes
 *      nothing until the user presses «Провести»;
 *   2) the whole set is reverted by «Отменить набор»;
 *   3) a doubtful position is answered by tapping one of the offered products
 *      instead of retyping the command;
 *   4) the card fits a 390 px phone screen and its buttons stay thumb-sized.
 *
 * Usage: node scripts/src/check-assistant-ui.mjs [width] [height]
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

// The two definite products and the doubtful word both come from the seeded
// catalog, so the catalog is reset before the check starts.
seedDatabase();

const here = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 1440);
const height = Number(process.argv[3] ?? 1000);
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const base = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const port = 9351;
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-assistant-ui-"));

const browser = spawn(
  edge,
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggingTarget() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // not ready
    }
    await sleep(250);
  }
  throw new Error("Could not reach the Edge debugging endpoint");
}

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();

  static async connect(wsUrl) {
    const client = new Cdp();
    client.#socket = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener("open", resolve, { once: true });
      client.#socket.addEventListener("error", reject, { once: true });
    });
    client.#socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const pending = client.#pending.get(message.id);
      if (!pending) return;
      client.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
    });
    return client;
  }

  send(method, params = {}) {
    const id = this.#nextId++;
    this.#socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 60000);
    });
  }

  close() {
    this.#socket.close();
  }
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

// Set once the session exists; catalog lookups outside the browser use it.
let sessionCookie = "";

const products = async () =>
  fetch(`${api}/api/products`, { headers: { cookie: sessionCookie } }).then((response) =>
    response.json(),
  );

/**
 * Stock is looked up by name, not by id.
 *
 * Another check may re-seed the database while this one runs; a seed keeps the
 * catalog names and changes every id, so a name survives what an id does not.
 */
const stockOf = async (name) => {
  const product = (await products()).find((item) => item.name === name);
  if (!product) {
    throw new Error(
      `Товар «${name}» исчез из каталога — база была пересеяна во время проверки, перезапустите её`,
    );
  }
  return product.currentStock;
};

/** Waits for a stock value to settle; used right after a write. */
async function waitForStock(name, expected, attempts = 20) {
  let value = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    value = await stockOf(name);
    if (value === expected) return { ok: true, value };
    await sleep(500);
  }
  return { ok: false, value };
}

/** Types into the composer the way a user does: React only sees real input. */
async function typeCommand(cdp, text) {
  const focused = await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector('form input:not([type=file])');
      if (!input) return false;
      input.focus();
      input.setSelectionRange(0, input.value.length);
      return true;
    })()`,
  );
  if (!focused) return null;
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Backspace",
    code: "Backspace",
    windowsVirtualKeyCode: 8,
    nativeVirtualKeyCode: 8,
  });
  await cdp.send("Input.insertText", { text });
  await sleep(250);
  return evaluate(
    cdp,
    `document.querySelector('form input:not([type=file])')?.value ?? null`,
  );
}

const clickButton = (cdp, predicate) =>
  evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => ${predicate});
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );

/** Sends whatever is in the composer. */
const submitCommand = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('button[type=submit]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
  );

const command = async (cdp, text) => {
  const typed = await typeCommand(cdp, text);
  await sleep(200);
  const sent = await submitCommand(cdp);
  return { typed, sent };
};

/**
 * Every preview card in the thread, newest last.
 *
 * The card is located the same way the invoice check locates its own card: by
 * the heading inside it, so the check does not depend on extra test hooks.
 */
const readCards = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      const headings = [...document.querySelectorAll('span')].filter((s) => s.textContent === 'Разбор команды');
      return headings.map((heading) => {
        const root = heading.closest('div.rounded-xl');
        if (!root) return null;
        const buttons = [...root.querySelectorAll('button')].map((b) => ({
          label: (b.textContent ?? '').replace(/\\s+/g, ' ').trim(),
          aria: b.getAttribute('aria-label'),
          disabled: b.disabled,
          height: Math.round(b.getBoundingClientRect().height),
          icons: b.querySelectorAll('svg').length,
        }));
        return {
          text: root.innerText.replace(/\\s+/g, ' ').trim(),
          buttons,
          items: [...root.querySelectorAll('li')].map((li) =>
            li.innerText.replace(/\\s+/g, ' ').trim(),
          ),
          width: Math.round(root.getBoundingClientRect().width),
        };
      }).filter(Boolean);
    })()`,
  );

/** Waits until one of the cards satisfies the predicate. */
async function waitForCard(cdp, predicate, attempts = 90) {
  let cards = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    cards = await readCards(cdp);
    const found = predicate(cards);
    if (found) return { card: found, cards };
    await sleep(1000);
  }
  return { card: null, cards };
}

const results = [];
const record = (scope, label, ok, detail) =>
  results.push([scope, label, Boolean(ok), detail]);

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  const session = await signInBrowser(cdp);
  sessionCookie = session.cookieHeader;
  console.log("signed in:", session.cookies.map((cookie) => cookie.name).join(", "));
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${base}/assistant` });
  await sleep(4000);

  const catalog = await products();
  const stockProducts = catalog.filter((product) => product.productType === "stock");
  const doubtfulWord = "роза";
  const doubtful = stockProducts.filter((product) =>
    product.name.toLowerCase().includes(doubtfulWord),
  );
  // The definite positions must stay unconnected to the doubtful word, otherwise
  // the second scenario would resolve them instead of asking.
  const definite = stockProducts.filter(
    (product) => !product.name.toLowerCase().includes(doubtfulWord),
  );
  const [clearOne, clearTwo] = definite;
  if (!clearOne || !clearTwo || doubtful.length < 2) {
    throw new Error(
      `В каталоге не хватает товаров: однозначные ${clearOne?.name}, ${clearTwo?.name}; спорные ${doubtful.length}`,
    );
  }
  console.log(
    `catalog: ${clearOne.name} (${clearOne.currentStock}), ${clearTwo.name} (${clearTwo.currentStock}); ` +
      `«${doubtfulWord}»: ${doubtful.map((product) => product.name).join(", ")}`,
  );

  const before = {
    one: await stockOf(clearOne.name),
    two: await stockOf(clearTwo.name),
  };

  // ------------------------------------- 1. composite command shows a preview
  console.log("\n=== 1. Составная команда показывает разбор без записи ===");
  const composite = `Продажа 1 ${clearOne.name}, 1 ${clearTwo.name}`;
  const sent = await command(cdp, composite);
  record("разбор", "команда введена и отправлена", sent.typed === composite && sent.sent, JSON.stringify(sent));

  // The assistant needs a few seconds; the waiting bubble has to say so.
  let waiting = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    waiting = await evaluate(
      cdp,
      `document.body.innerText.includes('Разбираю команду')`,
    );
    if (waiting) break;
    await sleep(400);
  }
  record("разбор", "во время разбора видно состояние ожидания", waiting);

  // Фокус должен вернуться в поле: иначе для следующей команды приходится
  // щёлкать мышью по полю ввода.
  const focusState = await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector('form input:not([type=file])');
      const active = document.activeElement;
      return {
        exists: Boolean(input),
        disabled: input ? input.disabled : null,
        focused: Boolean(input) && active === input,
        activeTag: active ? active.tagName.toLowerCase() : null,
      };
    })()`,
  );
  console.log("focus after waiting:", JSON.stringify(focusState));
  record(
    "разбор",
    "поле ввода не блокируется во время запроса",
    focusState?.disabled === false,
    JSON.stringify(focusState),
  );

  const preview = await waitForCard(
    cdp,
    (cards) => {
      const last = cards[cards.length - 1];
      return last && last.text.includes(clearOne.name) && last.text.includes(clearTwo.name)
        ? last
        : null;
    },
  );
  const previewCard = preview.card;
  console.log("preview card:", JSON.stringify(previewCard));
  record("разбор", "появилась карточка предпросмотра", Boolean(previewCard));
  record(
    "разбор",
    "в карточке две позиции с человекочитаемым текстом",
    previewCard?.items.filter((item) => item.includes("«")).length >= 2 &&
      previewCard.items.some((item) => item.includes(clearOne.name)) &&
      previewCard.items.some((item) => item.includes(clearTwo.name)),
    JSON.stringify(previewCard?.items),
  );
  record(
    "разбор",
    "карточка предлагает кнопку «Провести»",
    previewCard?.buttons.some((button) => button.label.startsWith("Провести")),
    JSON.stringify(previewCard?.buttons.map((button) => button.label)),
  );
  record(
    "разбор",
    "до подтверждения склад не изменён",
    (await stockOf(clearOne.name)) === before.one &&
      (await stockOf(clearTwo.name)) === before.two,
    JSON.stringify({
      before,
      now: [await stockOf(clearOne.name), await stockOf(clearTwo.name)],
    }),
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-assistant-preview.png", shot.data);

  // ------------------------------------------- 2. confirming writes the set
  console.log("\n=== 2. «Провести» проводит весь набор ===");
  // Re-read the baseline right before the write, so an unrelated movement from
  // another check cannot be mistaken for this one.
  const beforeApply = {
    one: await stockOf(clearOne.name),
    two: await stockOf(clearTwo.name),
  };
  const confirmed = await clickButton(cdp, `b.textContent?.trim().startsWith('Провести')`);
  record("проведение", "кнопка «Провести» нажата", confirmed);

  const applied = await waitForCard(
    cdp,
    (cards) => {
      const last = cards[cards.length - 1];
      return last && last.text.includes("Проведено позиций") ? last : null;
    },
    45,
  );
  const appliedCard = applied.card;
  console.log("applied card:", JSON.stringify(appliedCard));
  record("проведение", "карточка сменилась результатом", Boolean(appliedCard));
  record(
    "проведение",
    "результат сообщает о двух проведённых позициях",
    appliedCard?.text.includes("Проведено позиций: 2"),
    appliedCard?.text,
  );

  const decreasedOne = await waitForStock(clearOne.name, beforeApply.one - 1);
  const decreasedTwo = await waitForStock(clearTwo.name, beforeApply.two - 1);
  record(
    "проведение",
    "остатки обеих позиций уменьшились на 1",
    decreasedOne.ok && decreasedTwo.ok,
    JSON.stringify({
      before: beforeApply,
      now: [decreasedOne.value, decreasedTwo.value],
    }),
  );
  record(
    "проведение",
    "применённый набор предлагает отмену целиком",
    appliedCard?.buttons.some((button) => button.label.includes("Отменить набор")),
    JSON.stringify(appliedCard?.buttons.map((button) => button.label)),
  );

  const appliedShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-assistant-applied.png"),
    Buffer.from(appliedShot.data, "base64"),
  );

  // ------------------------------------------- 3. the whole set is reverted
  console.log("\n=== 3. «Отменить набор» возвращает остатки ===");
  const undoClicked = await clickButton(cdp, `b.textContent?.includes('Отменить набор')`);
  record("отмена", "кнопка «Отменить набор» нажата", undoClicked);

  const undone = await waitForCard(
    cdp,
    (cards) => {
      const last = cards[cards.length - 1];
      return last && last.text.includes("Набор отменён") ? last : null;
    },
    45,
  );
  record("отмена", "карточка сообщает об отмене набора", Boolean(undone.card), undone.card?.text);
  record(
    "отмена",
    "ответ сервера об отмене показан в ленте",
    (await evaluate(cdp, `document.body.innerText.includes('Набор операций отменён')`)),
  );

  let restored = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    restored =
      (await stockOf(clearOne.name)) === beforeApply.one &&
      (await stockOf(clearTwo.name)) === beforeApply.two;
    if (restored) break;
    await sleep(500);
  }
  record(
    "отмена",
    "остатки вернулись к исходным",
    restored,
    JSON.stringify({
      before: beforeApply,
      now: [await stockOf(clearOne.name), await stockOf(clearTwo.name)],
    }),
  );

  // ------------------------------------- 4. doubtful position offers options
  console.log("\n=== 4. Спорная позиция решается нажатием варианта ===");
  const doubtfulCommand = `Продажа 1 ${doubtfulWord}`;
  await command(cdp, doubtfulCommand);

  const clarification = await waitForCard(
    cdp,
    (cards) => {
      const last = cards[cards.length - 1];
      return last && last.text.includes("Нужно уточнить") ? last : null;
    },
  );
  const clarificationCard = clarification.card;
  console.log("clarification card:", JSON.stringify(clarificationCard));
  record("уточнение", "появилась карточка с уточнением", Boolean(clarificationCard));
  record(
    "уточнение",
    "спорная позиция названа вместе с количеством",
    clarificationCard?.text.includes(doubtfulWord) &&
      clarificationCard?.text.includes("1 ед."),
    clarificationCard?.text,
  );

  const options = (clarificationCard?.buttons ?? []).filter((button) =>
    String(button.aria ?? "").startsWith("Выбрать товар"),
  );
  record(
    "уточнение",
    "предложены варианты товаров с остатками",
    options.length >= 2 && options.every((option) => /остаток \d/u.test(String(option.aria))),
    JSON.stringify(options.map((option) => option.aria)),
  );
  record(
    "уточнение",
    "пока товар не выбран, набор не проводится",
    clarificationCard?.buttons.some(
      (button) => button.label.startsWith("Провести") && button.disabled,
    ),
    JSON.stringify(clarificationCard?.buttons.map((button) => `${button.label}:${button.disabled}`)),
  );

  // Checked while the doubtful card is on screen: a phone must show the same
  // card without sideways scrolling and with thumb-sized buttons.
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(1200);
  const mobile = await evaluate(
    cdp,
    `(() => {
      const headings = [...document.querySelectorAll('span')].filter((s) => s.textContent === 'Разбор команды');
      const root = headings[headings.length - 1]?.closest('div.rounded-xl');
      if (!root) return null;
      const buttons = [...root.querySelectorAll('button')].map((b) => ({
        label: (b.textContent ?? '').replace(/\\s+/g, ' ').trim(),
        height: Math.round(b.getBoundingClientRect().height),
      }));
      const measured = {
        width: Math.round(root.getBoundingClientRect().width),
        viewport: document.documentElement.clientWidth,
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        buttons,
      };
      // Scrolled into view only after measuring, so the artifact shows the card
      // a phone user would be looking at.
      root.scrollIntoView({ block: 'center' });
      return measured;
    })()`,
  );
  console.log("mobile layout:", JSON.stringify(mobile));
  record(
    "мобильный вид",
    "карточка помещается в экран 390 px",
    mobile && mobile.width <= mobile.viewport && mobile.pageOverflow === 0,
    JSON.stringify(mobile),
  );
  record(
    "мобильный вид",
    "кнопки карточки не меньше 44 px по высоте",
    mobile && mobile.buttons.length > 0 && mobile.buttons.every((button) => button.height >= 44),
    JSON.stringify(mobile?.buttons),
  );

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-assistant-mobile.png"),
    Buffer.from(mobileShot.data, "base64"),
  );

  await cdp.send("Emulation.clearDeviceMetricsOverride");
  await sleep(800);
  await evaluate(
    cdp,
    `(() => {
      const scroller = document.querySelector('.overflow-y-auto');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      return true;
    })()`,
  );

  const chosenLabel = options[0]?.aria ?? "";
  const chosen = doubtful.find((product) =>
    chosenLabel.startsWith(`Выбрать товар ${product.name},`),
  );
  const doubtfulBefore = Object.fromEntries(
    await Promise.all(doubtful.map(async (product) => [product.name, await stockOf(product.name)])),
  );
  record("уточнение", "вариант сопоставлен с товаром каталога", Boolean(chosen), chosenLabel);

  const picked = await clickButton(
    cdp,
    `(b.getAttribute('aria-label') ?? '').startsWith(${JSON.stringify(chosenLabel)})`,
  );
  record("уточнение", "вариант товара нажат", picked);

  const resolved = await waitForCard(
    cdp,
    (cards) => {
      const last = cards[cards.length - 1];
      return last && last.text.includes("Проведено позиций") ? last : null;
    },
    45,
  );
  record("уточнение", "нажатие варианта провело операцию", Boolean(resolved.card), resolved.card?.text);

  const marked = (resolved.card?.buttons ?? []).filter((button) =>
    String(button.aria ?? "").startsWith("Выбрать товар"),
  );
  record(
    "уточнение",
    "выбранный вариант отмечен в карточке",
    marked.some((button) => button.aria === chosenLabel && button.icons > 0) &&
      marked.filter((button) => button.icons > 0).length === 1,
    JSON.stringify(marked.map((button) => `${button.aria}:${button.icons}`)),
  );

  let doubtfulAfter = {};
  let doubtfulDecreased = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    doubtfulAfter = Object.fromEntries(
      await Promise.all(doubtful.map(async (product) => [product.name, await stockOf(product.name)])),
    );
    const moved = doubtful.filter(
      (product) => doubtfulAfter[product.name] !== doubtfulBefore[product.name],
    );
    doubtfulDecreased =
      Boolean(chosen) &&
      moved.length === 1 &&
      moved[0].name === chosen.name &&
      doubtfulAfter[chosen.name] === doubtfulBefore[chosen.name] - 1;
    if (doubtfulDecreased) break;
    await sleep(500);
  }
  record(
    "уточнение",
    "остаток выбранного товара уменьшился на 1, остальные не тронуты",
    doubtfulDecreased,
    JSON.stringify({ before: doubtfulBefore, after: doubtfulAfter, chosen: chosen?.name }),
  );

  const resolvedShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-assistant-clarified.png"),
    Buffer.from(resolvedShot.data, "base64"),
  );

  // --------------------------- 5. длинный список товаров открывается выпадающим
  console.log("\n=== 5. Много вариантов: выпадающий список с поиском ===");
  await command(cdp, doubtfulCommand);

  const dropdownCard = await waitForCard(
    cdp,
    (cards) => {
      const last = cards[cards.length - 1];
      return last && last.text.includes("Нужно уточнить") ? last : null;
    },
  );

  const totalOptions = dropdownCard.card?.buttons.filter((button) =>
    String(button.aria ?? "").startsWith("Выбрать товар"),
  ).length ?? 0;
  const dropdownTrigger = dropdownCard.card?.buttons.find((button) =>
    String(button.aria ?? "").startsWith("Показать все товары"),
  );
  console.log(
    "options on card:",
    totalOptions,
    "| trigger:",
    dropdownTrigger?.aria ?? "нет",
  );
  record(
    "список",
    "при многих вариантах есть кнопка полного списка",
    totalOptions > 4 ? Boolean(dropdownTrigger) : true,
    totalOptions > 4
      ? `вариантов на карточке: ${totalOptions}`
      : `вариантов всего ${totalOptions} — они показаны кнопками, полный список не нужен`,
  );

  if (!dropdownTrigger) {
    console.log(
      `  пропускаю проверку выпадающего списка: подходящих товаров ${totalOptions}, ` +
        "кнопка полного списка появляется при пяти и более",
    );
  }

  if (dropdownTrigger) {
    const opened = await evaluate(
      cdp,
      `(() => {
        const button = [...document.querySelectorAll('button')].find((b) =>
          String(b.getAttribute('aria-label') || '').startsWith('Показать все товары'));
        if (!button) return 'кнопки нет';
        button.click();
        return 'нажата';
      })()`,
    );
    await sleep(900);
    const popover = await evaluate(
      cdp,
      `(() => {
        const input = document.querySelector('input[aria-label^="Поиск товара"]');
        const options = [...document.querySelectorAll('button[aria-label^="Выбрать товар"]')]
          .filter((b) => b.closest('[data-radix-popper-content-wrapper]'));
        return { hasSearch: Boolean(input), options: options.length };
      })()`,
    );
    console.log("dropdown:", opened, JSON.stringify(popover));
    record("список", "выпадающий список открылся", opened === "нажата", String(opened));
    record("список", "в списке есть поиск по названию", popover?.hasSearch === true, JSON.stringify(popover));
    record(
      "список",
      "в списке есть варианты товаров",
      (popover?.options ?? 0) >= 2,
      JSON.stringify(popover),
    );
  }

  cdp.close();
} finally {
  browser.kill();
  await sleep(600);
  rmSync(profile, { recursive: true, force: true });
}

console.log("\nresults:");
let failed = 0;
for (const [scope, label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} [${scope}] ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
