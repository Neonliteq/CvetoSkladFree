/**
 * Всплывающая подсказка графиков: непрозрачный фон и читаемый текст.
 *
 * Дефект, ради которого написана проверка: фон задавался как `var(--card)`, а это тройка
 * HSL, а не цвет — браузер значение отбрасывал, подсказка рисовалась прозрачной поверх
 * линий. Поэтому проверка **измеряет** вычисленный фон (альфа должна быть 1) и контраст
 * текста подсказки, а не ищет классы в разметке.
 *
 * Тем две — проверяются обе: ошибка была видна в светлой, но тёмную ломала так же.
 *
 * Usage: node scripts/src/check-analytics-tooltip-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9541);
seedDatabase();
ensureScreenshotsDir();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Наводит мышь на график и измеряет подсказку.
 *
 * Событие посылается настоящей мышью через CDP: Recharts слушает mousemove на области
 * графика, и синтетический `dispatchEvent` из страницы у него не всегда срабатывает.
 */
const measureTooltip = `(() => {
  const wrapper = document.querySelector('.recharts-tooltip-wrapper');
  if (!wrapper) return { found: false };
  const style = getComputedStyle(wrapper);
  // Recharts может держать подсказку в DOM скрытой, пока наведения не было.
  if (style.visibility === 'hidden' || Number(style.opacity) === 0) return { found: false, hidden: true };
  const box = wrapper.getBoundingClientRect();
  const surface = wrapper.firstElementChild ?? wrapper;
  const surfaceStyle = getComputedStyle(surface);
  const background = surfaceStyle.backgroundColor;
  const rgb = background.match(/[\\d.]+/g)?.map(Number) ?? [];
  const alpha = rgb.length === 4 ? rgb[3] : 1;
  const textNode = [...wrapper.querySelectorAll('*')]
    .find((node) => [...node.childNodes].some((child) => child.nodeType === 3 && child.textContent.trim()));
  const textStyle = textNode ? getComputedStyle(textNode) : surfaceStyle;
  const resolve = (color) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const paint = (value, over) => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = over;
      ctx.fillRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
      return 'rgb(' + r + ', ' + g + ', ' + b + ')';
    };
    // Фон подсказки может быть полупрозрачным — тогда под ним карточка.
    const page = getComputedStyle(document.body).backgroundColor;
    const card = getComputedStyle(document.querySelector('.recharts-wrapper')?.closest('.rounded-xl') ?? document.body).backgroundColor;
    return { painted: paint(color, paint(card === 'rgba(0, 0, 0, 0)' ? page : card, page)) };
  };
  const luminance = (value) => {
    const parts = value.match(/\\d+/g).slice(0, 3).map(Number);
    const channels = parts.map((part) => {
      const c = part / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const backgroundPainted = resolve(background).painted;
  const textPainted = resolve(textStyle.color).painted;
  const l1 = luminance(textPainted);
  const l2 = luminance(backgroundPainted);
  const contrast = Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
  return {
    found: true,
    width: Math.round(box.width),
    height: Math.round(box.height),
    background,
    alpha,
    textColor: textStyle.color,
    contrast,
    text: (wrapper.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  };
})()`;

const profile = mkdtempSync(path.join(tmpdir(), "dsh-tooltip-"));
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
  const waitFor = async (expression, timeoutMs = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    throw new Error(`не дождались условия: ${expression}`);
  };

  /** Ведёт мышь по области графика, пока не появится подсказка. */
  const hoverChart = async () => {
    const box = await evaluate(`(() => {
      const wrapper = document.querySelector('.recharts-wrapper');
      if (!wrapper) return null;
      const rect = wrapper.getBoundingClientRect();
      return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
    })()`);
    if (!box) return false;
    // Несколько точек: подсказка появляется, когда курсор попадает в область данных.
    for (const fraction of [0.5, 0.35, 0.65, 0.2, 0.8]) {
      const x = box.x + Math.round(box.width * fraction);
      const y = box.y + Math.round(box.height * 0.5);
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none" });
      await sleep(400);
      const visible = await evaluate(
        `(() => { const w = document.querySelector('.recharts-tooltip-wrapper'); if (!w) return false; const s = getComputedStyle(w); return s.visibility !== 'hidden' && Number(s.opacity) > 0; })()`,
      );
      if (visible) return { x, y };
    }
    return false;
  };

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);

  const check = async (label, theme) => {
    console.log(`=== ${label} ===`);
    await cdp.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: theme }],
    });
    await cdp.send("Page.navigate", { url: `${ui}/analytics` });
    await waitFor(
      `getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)' && Boolean(document.querySelector('.recharts-wrapper'))`,
    );
    await sleep(1200);

    const darkClass = await evaluate(`document.documentElement.classList.contains('dark')`);
    record(
      `${label}: страница открылась в нужной теме`,
      theme === "dark" ? darkClass === true : darkClass === false,
      `dark=${darkClass}`,
    );

    const hovered = await hoverChart();
    record(`${label}: подсказка появилась при наведении`, Boolean(hovered), JSON.stringify(hovered));
    if (!hovered) return;

    const tooltip = await evaluate(measureTooltip);
    console.log("  измерено:", JSON.stringify(tooltip));
    record(
      `${label}: текст подсказки не пустой`,
      (tooltip?.text ?? "").length > 0,
      String(tooltip?.text),
    );
    record(
      `${label}: фон подсказки непрозрачный`,
      tooltip?.found === true && tooltip?.alpha === 1,
      `фон ${tooltip?.background} (альфа ${tooltip?.alpha})`,
    );
    record(
      `${label}: текст читается на фоне подсказки`,
      (tooltip?.contrast ?? 0) >= 4.5,
      `контраст ${tooltip?.contrast} (${tooltip?.textColor} на ${tooltip?.background})`,
    );
    record(
      `${label}: подсказка не пустая по размеру`,
      (tooltip?.width ?? 0) > 40 && (tooltip?.height ?? 0) > 20,
      `${tooltip?.width}×${tooltip?.height}`,
    );

    // Сетка и оси тоже рисовались невалидным цветом (`var(--border)` вместо
    // `var(--color-border)`) — проверяем, что теперь значения разрешились.
    const axes = await evaluate(`(() => {
      const grid = document.querySelector('.recharts-cartesian-grid line');
      const tick = document.querySelector('.recharts-cartesian-axis-tick-value');
      return {
        gridStroke: grid ? getComputedStyle(grid).stroke : null,
        tickColor: tick ? getComputedStyle(tick).fill : null,
      };
    })()`);
    console.log("  сетка и оси:", JSON.stringify(axes));
    record(
      `${label}: линии сетки получили цвет, а не отброшенное значение`,
      axes?.gridStroke !== null && axes?.gridStroke !== "none" && !String(axes?.gridStroke).includes("var("),
      String(axes?.gridStroke),
    );

    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    saveScreenshot(`check-analytics-tooltip-${theme}.png`, shot.data);
  };

  await check("светлая тема", "light");
  await check("тёмная тема", "dark");

  socket.close();
} catch (error) {
  record("проверка подсказки графиков", false, String(error).slice(0, 400));
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
