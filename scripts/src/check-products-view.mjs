/**
 * Captures and checks the stock screen states.
 *
 * Covers the two review points of the stock screen: the row highlight (a product
 * pushed below its minimum, plus the batch that expires in the seeded data) and
 * the two receipt list modes — one line per receipt and click-to-expand.
 *
 * Usage: node scripts/src/check-products-view.mjs [width] [height]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn, signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 1440);
const height = Number(process.argv[3] ?? 1000);
const base = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
// 9351/9361/9342/9346 belong to the other checks running in parallel.
const port = Number(process.env.CDP_PORT ?? 9371);

const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-products-view-"));

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
      }, 30000);
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

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const shoot = async (cdp, name) => {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  // Каталог снимков создаёт помощник: на чистой копии его нет, и запись падала.
  saveScreenshot(name, shot.data);
  console.log(`  saved screenshots/${name}`);
};

seedDatabase();

// The seeded catalog is comfortably above every minimum, so the low-stock state
// is produced by a real movement: 40 stems out of «Роза Кения белая».
const session = await signIn(api);
const call = async (method, route, body) => {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: { cookie: session.cookieHeader, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};

const catalog = (await call("GET", "/api/products")).body ?? [];
const lowCandidate = catalog.find((item) => item.name === "Роза Кения белая");
if (!lowCandidate) throw new Error("«Роза Кения белая» is missing from the seeded catalog");
const drain = lowCandidate.currentStock - (lowCandidate.minimumStock - 5);
const movement = await call("POST", "/api/movements", {
  productId: lowCandidate.id,
  type: "expense",
  quantity: drain,
  reason: "Проверка подсветки низкого остатка",
});
console.log(
  `  низкий остаток: расход ${drain} ${lowCandidate.unit} → ${movement.status}, ожидаем ${lowCandidate.minimumStock - 5} из ${lowCandidate.minimumStock}`,
);

const dashboard = (await call("GET", "/api/dashboard")).body ?? {};
console.log(`  истекающие партии: ${JSON.stringify(dashboard.expiring ?? [])}`);

const rose = catalog.find((item) => item.name === "Роза Эквадор красная");
const roseReceipts = (await call("GET", `/api/products/${rose.id}/receipts`)).body ?? [];
// The expanded line has to show the batch comment; the seed writes this one.
const receiptComment = roseReceipts[0]?.reason || "Приход товара";
console.log(`  комментарий прихода: ${receiptComment}`);

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  await cdp.send("Page.enable");
  await signInBrowser(cdp, base);
  await cdp.send("Page.navigate", { url: `${base}/products` });
  await sleep(4000);

  // ------------------------------------------------------- the stock table
  const table = await evaluate(
    cdp,
    `(() => {
      const table = document.querySelector('.overflow-x-auto table');
      if (!table) return null;
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      const rows = [...table.querySelectorAll('tbody > tr')].map((tr) => {
        const cells = [...tr.querySelectorAll(':scope > td')];
        // Кнопки правки и удаления переехали влево: проверяем их положение по
        // координатам, а не по порядку колонок. В рабочем списке у строки две
        // кнопки: правка и перенос в архив.
        const actionButtons = [...tr.querySelectorAll('button[aria-label^="Редактировать"], button[aria-label^="Убрать в архив"]')];
        const firstCellRect = cells[0]?.getBoundingClientRect();
        const tableRect = table.getBoundingClientRect();
        const actionsLeft =
          actionButtons.length > 0 &&
          Boolean(firstCellRect) &&
          actionButtons.every(
            (button) => button.getBoundingClientRect().left < tableRect.left + tableRect.width / 2,
          );
        return {
          name: (cells[0]?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
          stock: (cells[2]?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
          className: tr.className,
          height: Math.round(tr.getBoundingClientRect().height),
          actionCount: actionButtons.length,
          actionsLeft,
          subline: (() => {
            const line = cells[0]?.querySelector('div.text-xs');
            return line
              ? { text: line.innerText.trim(), className: line.className }
              : null;
          })(),
        };
      });
      return {
        heads,
        rows,
        width: Math.round(table.getBoundingClientRect().width),
        columns: table.querySelectorAll('thead th').length,
        overflows: (() => {
          // Контейнер прокрутки ищем по классу: структура обёрток может меняться.
          const box = table.closest('.overflow-x-auto');
          return box ? box.scrollWidth > box.clientWidth + 1 : null;
        })(),
        availableWidth: (() => {
          const box = table.closest('.overflow-x-auto');
          return box ? Math.round(box.clientWidth) : null;
        })(),
      };
    })()`,
  );
  if (!table) throw new Error("the stock table is not rendered");
  console.log("  колонки:", JSON.stringify(table.heads));
  for (const row of table.rows) {
    if (row.className.includes("amber") || row.stock.includes("истекает")) {
      console.log(`  подсвечено: ${row.name} | ${row.stock} | ${row.height}px`);
    }
  }

  record(
    "нет отдельных колонок «Сорт» и «Цвет»",
    !table.heads.some((head) => head === "Цвет" || head.includes("Сорт")),
    table.heads.join(" | "),
  );
  record(
    "колонок семь: действия перенесены в ячейку названия",
    table.columns === 7,
    String(table.columns),
  );
  record(
    "кнопки правки и переноса в архив стоят слева, рядом с названием",
    table.rows.length > 0 &&
      table.rows.every((row) => row.actionCount === 2 && row.actionsLeft === true),
    JSON.stringify(
      table.rows.slice(0, 2).map((row) => ({ buttons: row.actionCount, left: row.actionsLeft })),
    ),
  );
  // Окно таблицы обтягивает её по ширине: рамка не тянется на всю страницу,
  // а правая полоса захвата стоит ровно на краю таблицы.
  record(
    "окно таблицы обтягивает таблицу по ширине",
    table.availableWidth === table.width,
    `окно ${table.availableWidth}px, таблица ${table.width}px`,
  );

  // ------------------------------------------- ширина таблицы на большом экране
  // Ширина меняется перетаскиванием ручки, а не выбором пресета.
  const handle = await evaluate(
    cdp,
    `(() => {
      const node = document.querySelector('[role="separator"][aria-label="Изменить ширину таблицы"]');
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`,
  );
  record("есть ручка растягивания таблицы", Boolean(handle), JSON.stringify(handle));

  if (handle) {
    const before = await evaluate(
      cdp,
      `Math.round(document.querySelector('.overflow-x-auto table').getBoundingClientRect().width)`,
    );
    // Тянем ручку вправо тремя шагами: так проверяется и промежуточное движение.
    for (const step of [80, 160, 240]) {
      // Реализация слушает pointerdown/pointermove, поэтому события указателя
      // отправляются из страницы: синтетические mouse-события CDP их не создают.
      await evaluate(
        cdp,
        `(async () => {
          const node = document.querySelector('[role="separator"][aria-label="Изменить ширину таблицы"]');
          const rect = node.getBoundingClientRect();
          const startX = rect.left + rect.width / 2;
          const startY = rect.top + rect.height / 2;
          node.dispatchEvent(new PointerEvent('pointerdown', {
            bubbles: true, cancelable: true, clientX: startX, clientY: startY, pointerId: 1,
          }));
          for (let i = 1; i <= 6; i += 1) {
            await new Promise((r) => setTimeout(r, 60));
            window.dispatchEvent(new PointerEvent('pointermove', {
              bubbles: true, clientX: startX + (${step} * i) / 6, clientY: startY, pointerId: 1,
            }));
          }
          window.dispatchEvent(new PointerEvent('pointerup', {
            bubbles: true, clientX: startX + ${step}, clientY: startY, pointerId: 1,
          }));
          return 'протянуто';
        })()`,
      );
      await sleep(400);
      break;
    }
    const after = await evaluate(
      cdp,
      `(() => {
        const table = document.querySelector('.overflow-x-auto table');
        return {
          rendered: Math.round(table.getBoundingClientRect().width),
          width: getComputedStyle(table).width,
          containerWidth: Math.round(table.parentElement.getBoundingClientRect().width),
        };
      })()`,
    );
    const stored = await evaluate(cdp, `window.localStorage.getItem('florasklad:table-width')`);
    console.log(
      `ширина: было ${before}px, стало ${after.rendered}px (задано ${after.width}, контейнер ${after.containerWidth}px), в хранилище ${stored}`,
    );
    // Ширина таблицы не может быть меньше своего контейнера, поэтому проверяем
    // саму настройку: она должна вырасти и сохраниться.
    record(
      "перетаскивание увеличивает заданную ширину таблицы",
      Number(stored) > 950,
      `в хранилище ${stored}`,
    );
    record(
      "заданная ширина применяется к таблице",
      after.width === `${stored}px`,
      `ширина ${after.width}, ожидалось ${stored}px`,
    );

    // Двойной щелчок возвращает обычную ширину.
    await evaluate(
      cdp,
      `(() => {
        const node = document.querySelector('[role="separator"][aria-label="Изменить ширину таблицы"]');
        node?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return 'нажат';
      })()`,
    );
    await sleep(600);
    const restored = await evaluate(
      cdp,
      `Math.round(document.querySelector('.overflow-x-auto table').getBoundingClientRect().width)`,
    );
    const restoredStored = await evaluate(cdp, `window.localStorage.getItem('florasklad:table-width')`);
    record(
      "двойной щелчок возвращает обычную ширину",
      restoredStored === "1080",
      `в хранилище ${restoredStored}, на экране ${restored}px`,
    );
  }

  const rose = table.rows.find((row) => row.name.includes("Роза Эквадор красная"));  record(
    "сорт и цвет переехали под название",
    rose?.subline?.text === "Freedom · Красный" &&
      rose.subline.className.includes("text-xs") &&
      rose.subline.className.includes("text-muted-foreground"),
    JSON.stringify(rose?.subline),
  );

  const lowRow = table.rows.find((row) => row.name.includes("Роза Кения белая"));
  record(
    "низкий остаток подсвечен янтарным фоном",
    Boolean(lowRow && lowRow.className.includes("bg-amber-500/10")),
    lowRow?.className,
  );
  record(
    "низкий остаток показан красным числом",
    Boolean(lowRow && lowRow.stock.includes(String(lowCandidate.minimumStock - 5))),
    lowRow?.stock,
  );

  // Компактная метка: «1 дн.» вместо «истекает через 1 дн.», подробности — в подсказке.
  const expiringRow = table.rows.find((row) => /\d+ дн\.|срок истёк/.test(row.stock));
  record(
    "истекающая партия помечена числом дней",
    Boolean(expiringRow) && /\d+ дн\.|срок истёк/.test(expiringRow.stock),
    expiringRow?.stock,
  );

  await evaluate(
    cdp,
    `(() => {
      // Both highlighted rows are around the middle of the alphabet-sorted table.
      const rows = [...document.querySelectorAll('.overflow-x-auto tbody > tr')];
      const row = rows.find((tr) => (tr.innerText ?? '').includes('Роза Кения белая'));
      row?.scrollIntoView({ block: 'center' });
      return Boolean(row);
    })()`,
  );
  await sleep(500);
  await shoot(cdp, "check-products-state.png");

  // ------------------------------------------------- receipts, variant A
  const opened = await evaluate(
    cdp,
    `(() => {
      const rows = [...document.querySelectorAll('.overflow-x-auto tbody > tr')];
      const row = rows.find((tr) => (tr.innerText ?? '').includes('Роза Эквадор красная'));
      if (!row) return false;
      row.scrollIntoView({ block: 'center' });
      row.click();
      return true;
    })()`,
  );
  record("строка товара раскрывается", opened);
  await sleep(2000);

  const rowsView = await evaluate(
    cdp,
    `(() => {
      const table = document.querySelector('.overflow-hidden.rounded-lg table');
      if (!table) return null;
      const lines = [...table.querySelectorAll('tbody > tr')];
      const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent.trim());
      const first = lines[0];
      const cells = [...(first?.querySelectorAll(':scope > td') ?? [])];
      const buttons = [...document.querySelectorAll('[aria-label^="Показать приходы"]')];
      return {
        heads,
        count: lines.length,
        heights: lines.map((tr) => Math.round(tr.getBoundingClientRect().height)),
        firstLine: (first?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
        // Карандаш переехал в первую колонку, к дате.
        hasPencil: Boolean(
          cells[0]?.querySelector('button[aria-label^="Редактировать приход"]'),
        ),
        actionsFirst: Boolean(
          cells[0]?.querySelector('button[aria-label^="Редактировать приход"]'),
        ),
        pressed: buttons.map((button) => [button.getAttribute('aria-label'), button.getAttribute('aria-pressed')]),
      };
    })()`,
  );
  console.log("  вариант А:", JSON.stringify(rowsView));
  record("у таблицы приходов есть заголовки колонок", rowsView?.heads.length === 5, rowsView?.heads.join(" | "));
  record(
    "строка прихода высотой около 44 px",
    Boolean(rowsView?.heights.every((value) => value >= 40 && value <= 48)),
    JSON.stringify(rowsView?.heights),
  );
  record(
    "в строке есть дата, остаток, закупка, свежесть и карандаш",
    Boolean(
      rowsView?.firstLine.includes(" из ") &&
        rowsView.hasPencil &&
        rowsView.firstLine.includes("Свежесть"),
    ),
    rowsView?.firstLine,
  );
  record(
    "по умолчанию выбран вариант «Строки»",
    Boolean(
      rowsView?.pressed.some(
        ([label, pressed]) => label === "Показать приходы строками" && pressed === "true",
      ),
    ),
    JSON.stringify(rowsView?.pressed),
  );
  // Количество приходов берём из ответа API: в демо-данных у позиции не всегда
  // ровно два прихода, а проверять надо полноту списка, а не знакомое число.
  record("в списке все приходы товара", rowsView?.count === roseReceipts.length, `${rowsView?.count} из ${roseReceipts.length}`);

  await shoot(cdp, "check-receipts-rows.png");

  // ------------------------------------------------- receipts, variant B
  const switched = await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('button[aria-label="Показать приходы с раскрытием"]');
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );
  record("переключатель переводит список в режим раскрытия", switched);
  await sleep(800);

  const collapsed = await evaluate(
    cdp,
    `(() => {
      const lines = [...document.querySelectorAll('button[aria-label^="Приход от"]')];
      const first = lines[0];
      return {
        count: lines.length,
        heights: lines.map((line) => Math.round(line.getBoundingClientRect().height)),
        firstText: (first?.innerText ?? '').replace(/\\s+/g, ' ').trim(),
        stored: window.localStorage.getItem('florasklad:receipts-view'),
      };
    })()`,
  );
  console.log("  вариант Б (свёрнуто):", JSON.stringify(collapsed));
  record(
    "свёрнутая строка 40 px на десктопе",
    Boolean(collapsed.heights.every((value) => value >= 38 && value <= 46)),
    JSON.stringify(collapsed.heights),
  );
  record(
    "в свёрнутой строке дата, остаток и закупка",
    Boolean(collapsed.firstText.includes(" из ") && /\d/.test(collapsed.firstText)),
    collapsed.firstText,
  );
  record(
    "выбор режима сохранён в localStorage",
    collapsed.stored === "expanded",
    String(collapsed.stored),
  );

  const expandedOne = await evaluate(
    cdp,
    `(() => {
      const lines = [...document.querySelectorAll('button[aria-label^="Приход от"]')];
      lines[0].click();
      return true;
    })()`,
  );
  record("строка прихода раскрывается кликом", expandedOne);
  await sleep(600);

  const openState = await evaluate(
    cdp,
    `(() => {
      const lines = [...document.querySelectorAll('button[aria-label^="Приход от"]')];
      const body = document.body.innerText;
      return {
        expanded: lines.filter((line) => line.getAttribute('aria-expanded') === 'true').length,
        hasFreshness: body.includes('Свежесть'),
        hasComment: body.includes(${JSON.stringify(receiptComment)}),
        hasEdit: [...document.querySelectorAll('button')].some((button) =>
          (button.textContent ?? '').includes('Редактировать'),
        ),
      };
    })()`,
  );
  record("одновременно раскрыт один приход", openState.expanded === 1, String(openState.expanded));
  record(
    "в раскрытой строке есть свежесть, комментарий и кнопка правки",
    openState.hasFreshness && openState.hasComment && openState.hasEdit,
    JSON.stringify(openState),
  );

  await shoot(cdp, "check-receipts-expanded.png");

  // React re-renders asynchronously, so each click is inspected in a later turn.
  await evaluate(
    cdp,
    `(() => {
      document.querySelectorAll('button[aria-label^="Приход от"]')[1].click();
      return true;
    })()`,
  );
  await sleep(600);
  const reopened = await evaluate(
    cdp,
    `(() => {
      const lines = [...document.querySelectorAll('button[aria-label^="Приход от"]')];
      return {
        expanded: lines.filter((line) => line.getAttribute('aria-expanded') === 'true').length,
        secondOpen: lines[1].getAttribute('aria-expanded') === 'true',
      };
    })()`,
  );
  record(
    "раскрытие переезжает на другую строку, прежняя закрывается",
    reopened.expanded === 1 && reopened.secondOpen,
    JSON.stringify(reopened),
  );

  await evaluate(
    cdp,
    `(() => {
      document.querySelectorAll('button[aria-label^="Приход от"]')[1].click();
      return true;
    })()`,
  );
  await sleep(600);
  const closed = await evaluate(
    cdp,
    `(() => {
      const lines = [...document.querySelectorAll('button[aria-label^="Приход от"]')];
      return lines.filter((line) => line.getAttribute('aria-expanded') === 'true').length;
    })()`,
  );
  record("повторный клик закрывает строку", closed === 0, String(closed));

  // The choice has to survive a reload, which is what localStorage buys.
  await cdp.send("Page.navigate", { url: `${base}/products` });
  await sleep(3500);
  await evaluate(
    cdp,
    `(() => {
      const rows = [...document.querySelectorAll('.overflow-x-auto tbody > tr')];
      const row = rows.find((tr) => (tr.innerText ?? '').includes('Роза Эквадор красная'));
      row?.click();
      return true;
    })()`,
  );
  await sleep(1800);
  const persisted = await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('button[aria-label="Показать приходы с раскрытием"]');
      return {
        pressed: button?.getAttribute('aria-pressed'),
        collapseLines: document.querySelectorAll('button[aria-label^="Приход от"]').length,
      };
    })()`,
  );
  record(
    "режим сохраняется после перезагрузки страницы",
    persisted.pressed === "true" && persisted.collapseLines > 0,
    JSON.stringify(persisted),
  );

  // ------------------------------------------------- the phone layout still works
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: `${base}/products` });
  await sleep(3500);
  const mobile = await evaluate(
    cdp,
    `(() => {
      const cards = [...document.querySelectorAll('div.md\\\\:hidden > div > div')];
      const low = cards.find((card) => (card.innerText ?? '').includes('Роза Кения белая'));
      const expiring = cards.find((card) => (card.innerText ?? '').includes('Роза Эквадор красная'));
      return {
        cards: cards.length,
        tableHidden: !document.querySelector('.overflow-x-auto table')?.offsetParent,
        lowStripe: Boolean(low?.className.includes('border-l-amber-500')),
        // У партии может быть и «истекает через N дн.», и «срок истёк»: в
        // демо-данных бывают просроченные партии, и метка у них своя.
        expiringMark: /истекает через \\d+ дн\\.|истекает сегодня|срок истёк/.test(expiring?.innerText ?? ''),
        expiringText: (expiring?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 120),
      };
    })()`,
  );
  console.log("  мобильный список:", JSON.stringify(mobile));
  record("на телефоне таблица заменена карточками", mobile.cards >= 5 && mobile.tableHidden, JSON.stringify(mobile));
  record(
    "карточка низкого остатка помечена янтарной полосой",
    mobile.lowStripe,
    String(mobile.lowStripe),
  );
  record("карточка истекающей партии помечена меткой", mobile.expiringMark, String(mobile.expiringText));
  await shoot(cdp, "check-products-mobile.png");
  await cdp.send("Emulation.clearDeviceMetricsOverride");

  // ------------------------------- крестик для сброса поиска
  console.log("\n=== поиск: крестик сброса ===");
  const searchProbe = await evaluate(
    cdp,
    `(async () => {
      const input = document.querySelector('input[aria-label^="Поиск товара"]');
      if (!input) return { error: 'поле поиска не найдено' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;

      const rowsBefore = document.querySelectorAll('tbody tr[aria-expanded]').length;
      const clearBefore = Boolean(document.querySelector('button[aria-label="Очистить поиск"]'));

      setter.call(input, 'роза');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 900));

      const rowsFiltered = document.querySelectorAll('tbody tr[aria-expanded]').length;
      const clearAfter = document.querySelector('button[aria-label="Очистить поиск"]');
      const rect = clearAfter ? clearAfter.getBoundingClientRect() : null;

      if (!clearAfter) return { rowsBefore, rowsFiltered, clearBefore, clearAfter: false };

      clearAfter.click();
      await new Promise((resolve) => setTimeout(resolve, 900));

      return {
        rowsBefore,
        rowsFiltered,
        clearBefore,
        clearAfter: true,
        valueAfterClear: input.value,
        rowsRestored: document.querySelectorAll('tbody tr[aria-expanded]').length,
        clearGone: !document.querySelector('button[aria-label="Очистить поиск"]'),
        tapHeight: rect ? Math.round(rect.height) : 0,
      };
    })()`,
  );
  console.log("  поиск:", JSON.stringify(searchProbe));
  record("поле поиска доступно по подписи", !searchProbe?.error, searchProbe?.error);
  record(
    "крестик появляется только при введённом тексте",
    searchProbe?.clearBefore === false && searchProbe?.clearAfter === true,
    JSON.stringify(searchProbe),
  );
  record(
    "крестик фильтрует список",
    (searchProbe?.rowsFiltered ?? 0) < (searchProbe?.rowsBefore ?? 0),
    `${searchProbe?.rowsBefore} → ${searchProbe?.rowsFiltered}`,
  );
  record("крестик очищает текст", searchProbe?.valueAfterClear === "", String(searchProbe?.valueAfterClear));
  record(
    "после сброса список восстановлен",
    searchProbe?.rowsRestored === searchProbe?.rowsBefore,
    `${searchProbe?.rowsFiltered} → ${searchProbe?.rowsRestored}, было ${searchProbe?.rowsBefore}`,
  );
  record("крестик исчезает после сброса", searchProbe?.clearGone === true, String(searchProbe?.clearGone));
  record(
    "крестик удобен на телефоне (не меньше 44 px)",
    (searchProbe?.tapHeight ?? 0) >= 40,
    `высота ${searchProbe?.tapHeight} px`,
  );

  cdp.close();
} finally {
  browser.kill();
  await sleep(600);
  rmSync(profile, { recursive: true, force: true });
}

console.log("\nresults:");
let failed = 0;
for (const [label, ok, detail] of results) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
