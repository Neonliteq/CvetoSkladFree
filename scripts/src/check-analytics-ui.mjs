/**
 * Проверяет страницу аналитики в интерфейсе.
 *
 * Смотрит то, что нельзя проверить по API: переключатель разбора, таблицу с
 * колонками под выбранный вид операций и то, что на телефоне ничего не уезжает.
 *
 * Usage: node scripts/src/check-analytics-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9450);
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
const profile = mkdtempSync(path.join(tmpdir(), "dsh-analytics-ui-"));
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
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 300));
    }
    return result.result?.value;
  };

  await signInBrowser(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${ui}/analytics` });
  await sleep(5000);

  console.log("=== 1. Сводные карточки ===");
  const cards = await evaluate(`(() => {
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const values = [...document.querySelectorAll('.text-2xl')].map((node) => node.textContent.trim());
    const deltas = [...document.querySelectorAll('span[title*="прошлый период"]')].map((node) =>
      node.textContent.trim(),
    );
    return {
      hasRevenue: text.includes('Выручка'),
      hasCost: text.includes('Себестоимость'),
      hasProfit: text.includes('Валовая прибыль'),
      hasSales: text.includes('Продажи'),
      values,
      deltas,
      hasError: /Ошибка|Что-то пошло не так/i.test(text),
    };
  })()`);
  console.log("  карточки:", JSON.stringify(cards));
  record("все четыре карточки на месте", cards?.hasRevenue && cards?.hasCost && cards?.hasProfit && cards?.hasSales, JSON.stringify(cards));
  record("на странице нет ошибки", cards?.hasError === false, JSON.stringify(cards?.values));
  record(
    "в карточках есть суммы",
    (cards?.values ?? []).filter((value) => /₽|\d/.test(value)).length >= 4,
    JSON.stringify(cards?.values),
  );
  record(
    "рядом с итогами показано сравнение с прошлым периодом",
    (cards?.deltas ?? []).length >= 3 &&
      (cards?.deltas ?? []).every((text) => /к прошлому периоду|прошлый период пуст/.test(text)),
    JSON.stringify(cards?.deltas),
  );

  console.log("\n=== 1б. График разделён по видам операций ===");
  const chart = await evaluate(`(() => {
    const names = [...document.querySelectorAll('.recharts-legend-item-text, .recharts-line')]
      .map((node) => node.textContent.trim())
      .filter(Boolean);
    const lines = document.querySelectorAll('.recharts-line').length;
    const bars = document.querySelectorAll('.recharts-bar').length;
    const ticks = [...document.querySelectorAll('.recharts-xAxis .recharts-cartesian-axis-tick-value')]
      .map((node) => node.textContent.trim())
      .slice(0, 3);
    return { names: [...new Set(names)].slice(0, 6), lines, bars, ticks };
  })()`);
  console.log("  график:", JSON.stringify(chart));
  record(
    "на графике суммы три линии: выручка, закупки, списания",
    (chart?.lines ?? 0) === 3,
    JSON.stringify(chart),
  );
  record(
    "на графике количества три столбца",
    (chart?.bars ?? 0) === 3,
    JSON.stringify(chart),
  );
  record(
    "подписи дат на оси — дд.мм",
    (chart?.ticks ?? []).length > 0 && (chart?.ticks ?? []).every((tick) => /^\d{2}\.\d{2}$/.test(tick)),
    JSON.stringify(chart?.ticks),
  );
  record(
    "у графика есть подписи линий",
    ["Выручка", "Закупки", "Списания"].every((name) => (chart?.names ?? []).includes(name)),
    JSON.stringify(chart?.names),
  );

  console.log("\n=== 1в. Сравнение с прошлым периодом ===");
  // По умолчанию период — неделя, и прошлая неделя в демо-данных не пустая:
  // сравнение должно показывать проценты, а не «прошлый период пуст».
  const compared = await evaluate(`(() => {
    const from = document.getElementById('dateFrom')?.value ?? '';
    const to = document.getElementById('dateTo')?.value ?? '';
    const days = from && to
      ? Math.round((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 86400000) + 1
      : 0;
    const today = new Date();
    const todayKey = [today.getFullYear(), today.getMonth() + 1, today.getDate()]
      .map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, '0')))
      .join('-');
    const deltas = [...document.querySelectorAll('span[title*="прошлый период"]')].map((node) =>
      node.textContent.trim(),
    );
    return { from, to, days, todayKey, deltas };
  })()`);
  console.log("  сравнение:", JSON.stringify(compared));
  record(
    "период по умолчанию — неделя по сегодняшний день",
    compared?.days === 7 && compared?.to === compared?.todayKey,
    JSON.stringify({ from: compared?.from, to: compared?.to, days: compared?.days, today: compared?.todayKey }),
  );
  record(
    "прошлый период не пуст: показаны проценты",
    (compared?.deltas ?? []).length >= 3 &&
      (compared?.deltas ?? []).every((text) => /^[+\u2212]\d+% к прошлому периоду$/.test(text)),
    JSON.stringify(compared?.deltas),
  );

  console.log("\n=== 2. Разбор по категориям ===");
  const initial = await evaluate(`(() => {
    const headings = [...document.querySelectorAll('h3, [class*="CardTitle"]')].map((node) => node.textContent.trim());
    const tables = [...document.querySelectorAll('table')];
    const last = tables[tables.length - 1];
    if (!last) return { headings, rows: 0 };
    const heads = [...last.querySelectorAll('thead th')].map((node) => node.textContent.trim());
    const rows = [...last.querySelectorAll('tbody tr')].map((row) =>
      [...row.querySelectorAll('td')].map((cell) => cell.textContent.trim()),
    );
    return { headings, heads, rows: rows.length, first: rows[0] ?? null };
  })()`);
  console.log("  таблица:", JSON.stringify(initial));
  record(
    "есть раздел разбора",
    (initial?.headings ?? []).some((heading) => /Разбор/.test(heading)),
    JSON.stringify(initial?.headings),
  );
  record(
    "колонки разбора под все виды операций",
    (initial?.heads ?? []).join("|") ===
      "Категория|Операций|Количество|Стоимость|Выручка|Себестоимость|Прибыль",
    JSON.stringify(initial?.heads),
  );
  record("в разборе есть строки", (initial?.rows ?? 0) > 0, `строк ${initial?.rows}`);
  record(
    "в строке есть числа",
    (initial?.first ?? []).some((cell) => /\d/.test(cell)),
    JSON.stringify(initial?.first),
  );

  console.log("\n=== 3. Переключение на разбор по товарам ===");
  await evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="Разбор аналитики"]');
    const button = [...group.querySelectorAll('button')]
      .find((node) => node.textContent.trim() === 'По товарам');
    button.click();
    return 'нажата';
  })()`);
  await sleep(2000);
  const byProduct = await evaluate(`(() => {
    const group = document.querySelector('[role="group"][aria-label="Разбор аналитики"]');
    const pressed = [...group.querySelectorAll('button')]
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.textContent.trim());
    const tables = [...document.querySelectorAll('table')];
    const last = tables[tables.length - 1];
    const heads = last ? [...last.querySelectorAll('thead th')].map((node) => node.textContent.trim()) : [];
    const rows = last ? last.querySelectorAll('tbody tr').length : 0;
    return { pressed, heads, rows };
  })()`);
  console.log("  по товарам:", JSON.stringify(byProduct));
  record(
    "выбран разбор по товарам",
    (byProduct?.pressed ?? []).join("|") === "По товарам",
    JSON.stringify(byProduct?.pressed),
  );
  record(
    "первая колонка стала «Товар»",
    byProduct?.heads?.[0] === "Товар" && (byProduct?.rows ?? 0) > 0,
    JSON.stringify(byProduct?.heads),
  );

  console.log("\n=== 4. Фильтр по продажам меняет колонки ===");
  // Тип операции — выпадающий список: выбираем «Продажа», у неё есть выручка.
  await evaluate(`(() => {
    const labels = [...document.querySelectorAll('label')];
    const label = labels.find((node) => node.textContent.trim() === 'Тип операций');
    const trigger = label?.parentElement?.querySelector('button[role="combobox"]');
    trigger.click();
    return 'открыт';
  })()`);
  await sleep(800);
  await evaluate(`(() => {
    const option = [...document.querySelectorAll('[role="option"]')]
      .find((node) => (node.textContent || '').trim() === 'Продажа');
    option.click();
    return 'выбрано';
  })()`);
  await sleep(2200);
  const salesView = await evaluate(`(() => {
    const tables = [...document.querySelectorAll('table')];
    const last = tables[tables.length - 1];
    const rows = last ? [...last.querySelectorAll('tbody tr')] : [];
    const cells = rows[0] ? [...rows[0].querySelectorAll('td')].map((cell) => cell.textContent.trim()) : [];
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    return {
      cells,
      rows: rows.length,
      hasDashes: cells.includes('—'),
      description: /Вид операций: Продажа/.test(text),
    };
  })()`);
  console.log("  продажи:", JSON.stringify(salesView));
  record("при продажах есть строки", (salesView?.rows ?? 0) > 0, JSON.stringify(salesView));
  record(
    "подпись разбора называет вид операций",
    salesView?.description === true,
    JSON.stringify(salesView),
  );
  record(
    "в строке продажи выручка заполнена, а не прочерк",
    (salesView?.cells?.[4] ?? "—") !== "—",
    JSON.stringify(salesView?.cells),
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-analytics.png", shot.data);

  console.log("\n=== 5. Аналитика на телефоне ===");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/analytics` });
  await sleep(5000);
  const mobile = await evaluate(`(() => {
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    return {
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      hasBreakdown: /Разбор/.test(text),
      hasCards: /Выручка/.test(text) && /Валовая прибыль/.test(text),
      groupButtons: [...document.querySelectorAll('[role="group"][aria-label="Разбор аналитики"] button')]
        .map((node) => Math.round(node.getBoundingClientRect().height)),
    };
  })()`);
  console.log("  телефон:", JSON.stringify(mobile));
  record("на телефоне разбор виден", mobile?.hasBreakdown === true, JSON.stringify(mobile));
  record("на телефоне карточки видны", mobile?.hasCards === true, JSON.stringify(mobile));
  record(
    "кнопки разбора не ниже 44 px",
    (mobile?.groupButtons ?? []).every((height) => height >= 44),
    JSON.stringify(mobile?.groupButtons),
  );
  record(
    "страница не едет вбок",
    (mobile?.overflowX ?? 1) <= 1,
    `overflowX ${mobile?.overflowX}`,
  );

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-analytics-mobile.png"),
    Buffer.from(mobileShot.data, "base64"),
  );

  socket.close();
} catch (error) {
  record("проверка аналитики в интерфейсе", false, String(error).slice(0, 300));
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
