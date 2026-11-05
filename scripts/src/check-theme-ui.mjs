/**
 * Проверяет тёмную тему: переключатель, сохранение выбора и читаемость.
 *
 * Смотреть на класс `dark` на <html> недостаточно: он может стоять, а палитра —
 * остаться светлой, и тогда текст на фоне не читается. Поэтому проверка **измеряет**
 * цвета, которые браузер действительно нарисовал, и считает контраст по формуле WCAG.
 *
 * Цвета разрешаются через canvas: Tailwind 4 отдаёт `oklch`, а полупрозрачные подложки
 * вида `oklab(... / 0.1)` — наивный разбор строки дал бы неверные числа (так первый
 * прогон и показал «контраст 21» у прозрачного фона).
 *
 * Usage: node scripts/src/check-theme-ui.mjs
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
const port = Number(process.env.CDP_PORT ?? 9511);
seedDatabase();
ensureScreenshotsDir();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const session = await signIn(api);

/**
 * Считает контраст каждого видимого текста с фоном, который под ним нарисован.
 *
 * Порог по WCAG: 4.5 для обычного текста, 3.0 для крупного (от 24px или жирного от
 * 18.66px). Проверяется весь текст страницы, а не выбранные элементы: иначе тёмная тема
 * «проходит» на заголовке и остаётся нечитаемой в таблице.
 */
const AUDIT = `(() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const paint = (color, over) => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = over ?? 'rgba(0, 0, 0, 0)';
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return 'rgb(' + r + ', ' + g + ', ' + b + ')';
  };
  const luminance = (rgb) => {
    const parts = rgb.match(/\\d+/g).slice(0, 3).map(Number);
    const channels = parts.map((value) => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const ratio = (a, b) => {
    const l1 = luminance(a);
    const l2 = luminance(b);
    return Number(((Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)).toFixed(2));
  };
  const backdropOf = (node) => {
    const chain = [];
    let current = node;
    while (current) {
      const colour = getComputedStyle(current).backgroundColor;
      if (colour && colour !== 'rgba(0, 0, 0, 0)') chain.unshift(colour);
      current = current.parentElement;
    }
    let result = 'rgb(255, 255, 255)';
    for (const colour of chain) result = paint(colour, result);
    return result;
  };
  const worst = [];
  const elements = [...document.querySelectorAll('body *')];
  for (const node of elements) {
    const ownText = [...node.childNodes]
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent.trim())
      .join('');
    if (!ownText) continue;
    const style = getComputedStyle(node);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) continue;
    const box = node.getBoundingClientRect();
    if (box.width <= 1 || box.height <= 1) continue;
    const backdrop = backdropOf(node);
    const foreground = paint(style.color, backdrop);
    const value = ratio(foreground, backdrop);
    const size = Number.parseFloat(style.fontSize);
    const bold = Number(style.fontWeight) >= 700;
    const large = size >= 24 || (bold && size >= 18.66);
    const threshold = large ? 3 : 4.5;
    if (value < threshold) {
      worst.push({
        text: ownText.slice(0, 40),
        ratio: value,
        threshold,
        colour: style.color,
        backdrop,
        className: String(node.className || '').slice(0, 80),
        tag: node.tagName.toLowerCase(),
      });
    }
  }
  worst.sort((a, b) => a.ratio - b.ratio);
  return {
    checked: elements.length,
    failures: worst.length,
    worst: worst.slice(0, 8),
    isDark: document.documentElement.classList.contains('dark'),
  };
})()`;

const profile = mkdtempSync(path.join(tmpdir(), "dsh-theme-ui-"));
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

  /**
   * Ждёт, пока условие станет истинным.
   *
   * Фиксированная пауза здесь врёт: в dev-режиме CSS и разметка приходят вместе с JS, и
   * измерение успевало застать страницу до отрисовки — прозрачный фон и белый текст,
   * то есть «контраст 21» на пустом месте. Условие готовности — реальное: появился
   * переключатель темы и у body есть нарисованный фон.
   */
  const waitFor = async (expression, timeoutMs = 25000) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await evaluate(expression)) return true;
      await sleep(250);
    }
    throw new Error(`не дождались условия: ${expression}`);
  };
  const waitForApp = () =>
    waitFor(`(() => {
      const painted = getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)';
      return painted && Boolean(document.querySelector('button[aria-label^="Тема"]'));
    })()`);
  const waitForPage = () =>
    waitFor(
      `getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)' && document.querySelectorAll('h1').length > 0`,
    );

  /**
   * Измеряет, что реально нарисовано: цвет фона страницы, цвет текста и контраст.
   *
   * Контраст считается по WCAG: отношение относительных яркостей. Порог 4.5 — обычный
   * текст; ниже него в зале на солнце не читается.
   */
  const measure = async () =>
    evaluate(`(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 1;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      const paint = (color, over) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = over;
        ctx.fillRect(0, 0, 1, 1);
        ctx.fillStyle = color;
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        return 'rgb(' + r + ', ' + g + ', ' + b + ')';
      };
      const luminance = (rgb) => {
        const parts = rgb.match(/\\d+/g).slice(0, 3).map(Number);
        const channels = parts.map((value) => {
          const c = value / 255;
          return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        });
        return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
      };
      const contrast = (a, b) => {
        const l1 = luminance(a);
        const l2 = luminance(b);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const html = document.documentElement;
      const body = document.body;
      const bodyStyle = getComputedStyle(body);
      const background = paint(bodyStyle.backgroundColor, 'rgb(255, 255, 255)');
      const heading = document.querySelector('h1');
      const headingStyle = heading ? getComputedStyle(heading) : null;
      const headingColour = headingStyle ? paint(headingStyle.color, background) : null;
      const sidebar = document.querySelector('aside');
      const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
      return {
        hasDarkClass: html.classList.contains('dark'),
        storedTheme: localStorage.getItem('florasklad-theme'),
        colorScheme: getComputedStyle(html).colorScheme,
        bodyBackground: background,
        bodyColor: paint(bodyStyle.color, background),
        bodyContrast: Number(contrast(background, paint(bodyStyle.color, background)).toFixed(2)),
        headingContrast: headingColour ? Number(contrast(background, headingColour).toFixed(2)) : null,
        sidebarBackground: sidebarStyle ? paint(sidebarStyle.backgroundColor, background) : null,
        themeColorMeta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
        toggleLabel: [...document.querySelectorAll('button[aria-label^="Тема"]')].map((node) => node.getAttribute('aria-label'))[0] ?? null,
      };
    })()`);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");

  console.log("=== 1. По умолчанию — как в системе ===");
  // Системная тема «тёмная»: приложение должно открыться тёмным без единого клика.
  await cdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/` });
  await waitForApp();
  await sleep(600);
  const systemDark = await measure();
  console.log("  измерено:", JSON.stringify(systemDark));
  record(
    "при системной тёмной теме приложение тёмное",
    systemDark?.hasDarkClass === true,
    JSON.stringify({ darkClass: systemDark?.hasDarkClass, stored: systemDark?.storedTheme }),
  );
  record(
    "фон действительно тёмный, а текст светлый",
    systemDark?.bodyContrast >= 4.5 && systemDark?.headingContrast >= 4.5,
    `контраст текста ${systemDark?.bodyContrast}, заголовка ${systemDark?.headingContrast}`,
  );
  record(
    "нативные элементы переключены на тёмный вид",
    systemDark?.colorScheme === "dark",
    String(systemDark?.colorScheme),
  );
  record(
    "переключатель показывает «как в системе»",
    String(systemDark?.toggleLabel ?? "").includes("Как в системе"),
    String(systemDark?.toggleLabel),
  );

  const darkShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-theme-dark.png", darkShot.data);

  console.log("=== 2. Каждый текст на страницах читается в тёмной теме ===");
  for (const route of ["/", "/movements", "/products", "/analytics", "/deliveries"]) {
    await cdp.send("Page.navigate", { url: `${ui}${route}` });
    await waitForPage();
    await sleep(1200);
    const audit = await evaluate(AUDIT);
    console.log(`  ${route}: проверено ${audit.checked} элементов, ниже порога ${audit.failures}`);
    for (const item of audit.worst) {
      console.log(
        `      ${item.ratio} < ${item.threshold} «${item.text}» ${item.tag} ${item.colour} на ${item.backdrop}`,
      );
      console.log(`          ${item.className}`);
    }
    record(
      `страница ${route} в тёмной теме читается`,
      audit.isDark === true && audit.failures === 0,
      `${audit.failures} элементов ниже порога`,
    );
  }

  console.log("=== 3. Переключение на светлую ===");
  await cdp.send("Page.navigate", { url: `${ui}/` });
  await waitForApp();
  await sleep(600);
  await evaluate(`(() => {
    const button = document.querySelector('button[aria-label^="Тема"]');
    if (!button) return false;
    button.click();
    return true;
  })()`);
  await sleep(1200);
  const light = await measure();
  console.log("  измерено:", JSON.stringify(light));
  record("класс dark снят", light?.hasDarkClass === false, String(light?.hasDarkClass));
  record(
    "фон стал светлым, текст тёмным и читаемым",
    light?.bodyContrast >= 4.5 && light?.headingContrast >= 4.5,
    `контраст текста ${light?.bodyContrast}, заголовка ${light?.headingContrast}`,
  );
  record("нативные элементы светлые", light?.colorScheme === "light", String(light?.colorScheme));
  record("выбор сохранён", light?.storedTheme === "light", String(light?.storedTheme));

  // Светлая тема тоже проверяется: правки для тёмной не должны ухудшить её.
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await waitForPage();
  await sleep(1200);
  const lightAudit = await evaluate(AUDIT);
  console.log(`  /movements в светлой: ниже порога ${lightAudit.failures}`);
  for (const item of lightAudit.worst) {
    console.log(
      `      ${item.ratio} < ${item.threshold} «${item.text}» ${item.tag} ${item.colour} на ${item.backdrop}`,
    );
    console.log(`          ${item.className}`);
  }
  record(
    "страница операций читается и в светлой теме",
    lightAudit.isDark === false && lightAudit.failures === 0,
    `${lightAudit.failures} элементов ниже порога`,
  );

  const lightShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-theme-light.png", lightShot.data);

  console.log("=== 4. Выбор переживает перезагрузку ===");
  await cdp.send("Page.navigate", { url: `${ui}/` });
  await waitForApp();
  await sleep(600);
  const afterReload = await measure();
  record(
    "после перезагрузки тема осталась светлой",
    afterReload?.hasDarkClass === false && afterReload?.storedTheme === "light",
    JSON.stringify({ dark: afterReload?.hasDarkClass, stored: afterReload?.storedTheme }),
  );

  console.log("=== 5. Круг переключений до тёмной и обратно ===");
  await evaluate(`document.querySelector('button[aria-label^="Тема"]').click()`);
  await sleep(1000);
  const darkAgain = await measure();
  record(
    "следующее нажатие включает тёмную",
    darkAgain?.hasDarkClass === true && darkAgain?.storedTheme === "dark",
    JSON.stringify({ dark: darkAgain?.hasDarkClass, stored: darkAgain?.storedTheme }),
  );

  // Полоса браузера должна совпадать с боковой панелью: иначе на телефоне над
  // приложением висит плашка чужого цвета. Сравниваем цвета, а не строки.
  const sameColour = (hex, rgb) => {
    const toParts = (value) => {
      const hexMatch = /^#([0-9a-f]{6})$/i.exec(String(value ?? ""));
      if (hexMatch) {
        const number = Number.parseInt(hexMatch[1], 16);
        return [(number >> 16) & 255, (number >> 8) & 255, number & 255];
      }
      const rgbMatch = String(value ?? "").match(/\d+/g);
      return rgbMatch ? rgbMatch.slice(0, 3).map(Number) : null;
    };
    const a = toParts(hex);
    const b = toParts(rgb);
    if (!a || !b) return false;
    return a.every((part, index) => Math.abs(part - b[index]) <= 2);
  };
  record(
    "полоса браузера совпадает с боковой панелью в тёмной теме",
    sameColour(darkAgain?.themeColorMeta, darkAgain?.sidebarBackground),
    `полоса ${darkAgain?.themeColorMeta}, панель ${darkAgain?.sidebarBackground}`,
  );
  record(
    "полоса браузера совпадает с боковой панелью в светлой теме",
    sameColour(light?.themeColorMeta, light?.sidebarBackground),
    `полоса ${light?.themeColorMeta}, панель ${light?.sidebarBackground}`,
  );

  await evaluate(`document.querySelector('button[aria-label^="Тема"]').click()`);
  await sleep(1000);
  const backToSystem = await measure();
  record(
    "третье нажатие возвращает «как в системе»",
    backToSystem?.storedTheme === "system" && backToSystem?.hasDarkClass === true,
    JSON.stringify({ stored: backToSystem?.storedTheme, dark: backToSystem?.hasDarkClass }),
  );

  console.log("=== 6. Тёмная тема в окнах, а не только на сводке ===");
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await waitForApp();
  await sleep(600);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')].find((node) => (node.textContent || '').trim() === 'Новая операция');
    if (button) button.click();
    return Boolean(button);
  })()`);
  await sleep(1300);
  const dialog = await evaluate(`(() => {
    const panel = document.querySelector('[role="dialog"]');
    if (!panel) return null;
    const style = getComputedStyle(panel);
    const input = panel.querySelector('input[type="date"]') ?? panel.querySelector('input');
    const inputStyle = input ? getComputedStyle(input) : null;
    return {
      background: style.backgroundColor,
      color: style.color,
      inputColorScheme: inputStyle?.colorScheme ?? null,
      isDark: style.backgroundColor.match(/\\d+/g)?.slice(0, 3).map(Number).every((value) => value < 80) ?? false,
    };
  })()`);
  console.log("  окно:", JSON.stringify(dialog));
  record("окно операции тоже тёмное", dialog?.isDark === true, JSON.stringify(dialog));
  record(
    "поле даты в окне без белой подложки",
    String(dialog?.inputColorScheme ?? "").includes("dark"),
    String(dialog?.inputColorScheme),
  );
  const dialogShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-theme-dialog.png", dialogShot.data);

  socket.close();
} catch (error) {
  record("проверка тёмной темы", false, String(error).slice(0, 400));
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
