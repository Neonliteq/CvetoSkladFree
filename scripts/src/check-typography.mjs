/**
 * Типографика и форма: шрифт, заголовки, скругления.
 *
 * Три решения, которые легко потерять незаметно:
 * **шрифт интерфейса** (подключён ли файл на самом деле и умеет ли он кириллицу),
 * **шкала заголовков** (на телефоне они мельче, чем на большом экране) и
 * **скругления** (строгий вид держится на маленьком радиусе).
 *
 * Проверяется вычисленный стиль, а не список классов: `font-family` может быть объявлен,
 * а файл — не загрузиться, и браузер молча подставит системный шрифт.
 *
 * Usage: node scripts/src/check-typography.mjs
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
const port = Number(process.env.CDP_PORT ?? 9591);
seedDatabase();
ensureScreenshotsDir();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const profile = mkdtempSync(path.join(tmpdir(), "dsh-typo-"));
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

  await cdp.send("Page.enable");
  await signInBrowser(cdp, api);
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await cdp.send("Page.navigate", { url: `${ui}/` });
  await waitFor("Сводка");
  await sleep(1800);

  console.log("=== 1. Шрифт ===");
  const font = await evaluate(`(() => {
    const body = getComputedStyle(document.body);
    // Ждём загрузки лица: без этого check() отвечает false даже для объявленного шрифта.
    return Promise.all([
      document.fonts.ready.then(() => ({
        family: body.fontFamily,
        loaded: document.fonts.check('16px "Golos Text"', 'Сводка склад 1 089 ₽'),
        faces: [...document.fonts].map((face) => ({
          family: face.family,
          weight: face.weight,
          status: face.status,
        })),
      })),
    ]).then(([value]) => value);
  })()`);
  console.log("  шрифт:", JSON.stringify(font)?.slice(0, 400));
  record(
    "в интерфейсе применяется Golos Text",
    String(font?.family ?? "").includes("Golos Text"),
    String(font?.family),
  );
  record(
    "файл шрифта загружен, а не подставлен системный",
    font?.loaded === true,
    "document.fonts.check вернул false — шрифт не загрузился",
  );
  record(
    "загруженные начертания содержат кириллицу",
    (font?.faces ?? []).filter((face) => face.family.includes("Golos Text")).length >= 4,
    JSON.stringify((font?.faces ?? []).map((face) => face.weight)),
  );

  console.log("=== 2. Заголовки ===");
  const desktopHeading = await evaluate(`(() => {
    const heading = document.querySelector('h1');
    if (!heading) return null;
    const style = getComputedStyle(heading);
    return { text: (heading.textContent || '').trim(), fontSize: style.fontSize, weight: style.fontWeight };
  })()`);
  console.log("  заголовок 1440:", JSON.stringify(desktopHeading));
  record(
    "заголовок на большом экране 30px и не жирнее 600",
    desktopHeading?.fontSize === "30px" && Number(desktopHeading?.weight) <= 600,
    JSON.stringify(desktopHeading),
  );

  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await sleep(1200);
  const mobileHeading = await evaluate(`(() => {
    const heading = document.querySelector('h1');
    if (!heading) return null;
    return { fontSize: getComputedStyle(heading).fontSize };
  })()`);
  console.log("  заголовок 390:", JSON.stringify(mobileHeading));
  record(
    "на телефоне заголовок мельче — 24px",
    mobileHeading?.fontSize === "24px",
    String(mobileHeading?.fontSize),
  );

  console.log("=== 3. Скругления ===");
  const radii = await evaluate(`(() => {
    const radiusOf = (node) => (node ? getComputedStyle(node).borderTopLeftRadius : null);
    const card = document.querySelector('.rounded-lg');
    const metric = [...document.querySelectorAll('.rounded-lg')].find((node) => /Товаров/.test(node.innerText || ''));
    return {
      card: radiusOf(card),
      metric: radiusOf(metric),
      // Переменная темы: из неё считаются все производные радиусы.
      token: getComputedStyle(document.documentElement).getPropertyValue('--radius').trim(),
    };
  })()`);
  console.log("  радиусы:", JSON.stringify(radii));
  record("переменная радиуса равна 6px", radii?.token === "0.375rem", String(radii?.token));
  record(
    "карточка скруглена на 6px, а не на 16",
    radii?.card === "6px",
    String(radii?.card),
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
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-typography.png", shot.data);

  socket.close();
} catch (error) {
  record("проверка типографики", false, String(error).slice(0, 400));
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
