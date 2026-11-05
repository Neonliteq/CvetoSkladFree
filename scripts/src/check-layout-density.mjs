/**
 * Плотность экранов и размеры целей нажатия.
 *
 * Задача проверки — держать два решения, которые легко потерять при правках:
 * **строки таблиц должны быть плотными** (иначе на экран влезает десяток операций), и
 * **на телефоне ничего не должно уменьшаться ниже 44px** (это уже меньше пальца).
 *
 * Числа замеряются, а не берутся из классов: правка отступов в другом месте может свести
 * плотность на нет, не тронув ни одного класса в таблице.
 *
 * Usage: node scripts/src/check-layout-density.mjs
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
const port = Number(process.env.CDP_PORT ?? 9581);
seedDatabase();
ensureScreenshotsDir();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(path.join(tmpdir(), "dsh-density-"));
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
  const waitFor = async (marker, timeoutMs = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const ok = await evaluate(
        `getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)' && document.body.innerText.includes(${JSON.stringify(marker)})`,
      );
      if (ok) return;
      await sleep(250);
    }
    throw new Error(`не дождались текста «${marker}»`);
  };
  /** Средняя высота строк таблицы и вертикальные отступы ячейки. */
  const tableGeometry = () =>
    evaluate(`(() => {
      const rows = [...document.querySelectorAll('tbody tr')].filter((row) => row.querySelector('td'));
      const heights = rows.map((row) => Math.round(row.getBoundingClientRect().height));
      const cell = rows[0]?.querySelector('td');
      const style = cell ? getComputedStyle(cell) : null;
      return {
        rows: heights.length,
        average: heights.length ? Math.round(heights.reduce((sum, value) => sum + value, 0) / heights.length) : null,
        paddingTop: style?.paddingTop ?? null,
        paddingBottom: style?.paddingBottom ?? null,
      };
    })()`);
  /** Все видимые кнопки ниже 44px по высоте. */
  const smallTargets = () =>
    evaluate(`(() => {
      const small = [...document.querySelectorAll('button')]
        .map((node) => {
          const rect = node.getBoundingClientRect();
          return { text: (node.textContent || '').trim().slice(0, 24), height: Math.round(rect.height), width: Math.round(rect.width) };
        })
        .filter((item) => item.height > 0 && item.height < 44);
      return { count: small.length, example: small.slice(0, 3) };
    })()`);

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);

  console.log("=== 1. Плотность таблиц на большом экране ===");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await waitFor("История операций");
  await sleep(1500);
  const movements = await tableGeometry();
  console.log("  операции:", JSON.stringify(movements));
  record(
    "строки операций плотные, не выше 60px",
    (movements?.average ?? 999) <= 60,
    `средняя высота ${movements?.average}px`,
  );
  record(
    "вертикальные отступы ячейки не больше 10px",
    Number.parseFloat(movements?.paddingTop ?? "99") <= 10,
    `padding ${movements?.paddingTop} / ${movements?.paddingBottom}`,
  );

  await cdp.send("Page.navigate", { url: `${ui}/products` });
  await waitFor("Склад");
  await sleep(1500);
  const products = await tableGeometry();
  console.log("  склад:", JSON.stringify(products));
  record(
    "строки склада тоже плотные, не выше 68px",
    (products?.average ?? 999) <= 68,
    `средняя высота ${products?.average}px`,
  );

  console.log("=== 2. Телефон: сводка помещается, цели не меньше 44px ===");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/` });
  await waitFor("Сводка");
  await sleep(1500);
  const mobile = await evaluate(`(() => {
    const top = (needle) => {
      const node = [...document.querySelectorAll('h1, h2, h3, [data-slot="card"], .rounded-xl, p, span, div')]
        .find((item) => (item.textContent || '').replace(/\\s+/g, ' ').trim().startsWith(needle));
      return node ? Math.round(node.getBoundingClientRect().top) : null;
    };
    // Показатели в две колонки: верх первых двух карточек совпадает. Карточки ищем по
    // подписям и поднимаемся к их контейнеру: у наших Card нет data-slot, а хвататься
    // за класс оформления — значит сломать проверку при смене стиля.
    const labels = ['Товаров', 'Единиц на складе', 'Стоимость склада', 'Истекает скоро'];
    const tops = labels.map((label) => {
      const leaf = [...document.querySelectorAll('p, span, div')]
        .find((item) => (item.textContent || '').replace(/\\s+/g, ' ').trim().toLowerCase() === label.toLowerCase());
      const card = leaf?.closest('[data-slot="card"]');
      return card ? Math.round(card.getBoundingClientRect().top) : null;
    });
    const twoColumns = tops.filter((value) => value !== null).length === 4
      && Math.abs(tops[0] - tops[1]) <= 2
      && Math.abs(tops[2] - tops[3]) <= 2;
    return {
      operationsTop: top('Последние операции'),
      viewportHeight: window.innerHeight,
      twoColumns,
      tops: tops.slice(0, 6),
    };
  })()`);
  console.log("  сводка:", JSON.stringify(mobile));
  record(
    "показатели на телефоне в две колонки",
    mobile?.twoColumns === true,
    JSON.stringify(mobile?.tops),
  );
  record(
    "последние операции видны на первом экране",
    (mobile?.operationsTop ?? 9999) < (mobile?.viewportHeight ?? 844),
    `операции на ${mobile?.operationsTop}px при экране ${mobile?.viewportHeight}px`,
  );

  const dashboardTargets = await smallTargets();
  console.log("  кнопки на сводке:", JSON.stringify(dashboardTargets));
  record(
    "на сводке все цели не меньше 44px",
    dashboardTargets?.count === 0,
    JSON.stringify(dashboardTargets?.example),
  );

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-layout-mobile-dashboard.png", mobileShot.data);

  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await waitFor("История операций");
  await sleep(1500);
  const movementTargets = await smallTargets();
  console.log("  кнопки на операциях:", JSON.stringify(movementTargets));
  record(
    "на операциях все цели не меньше 44px",
    movementTargets?.count === 0,
    JSON.stringify(movementTargets?.example),
  );

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await waitFor("История операций");
  await sleep(1500);
  const desktopShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-layout-density.png", desktopShot.data);

  socket.close();
} catch (error) {
  record("проверка плотности", false, String(error).slice(0, 400));
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
