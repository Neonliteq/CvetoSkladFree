/**
 * Проверяет экран «Настройки» в интерфейсе.
 *
 * Смотрит то, чего не видно из API: пункт меню есть у администратора и скрыт у
 * сотрудника, поля показывают сохранённое, ключ не выводится обратно, а кнопка
 * «Проверить связь» показывает ответ провайдера.
 *
 * Заглушка провайдера поднимается внутри скрипта: настоящий ключ проверке не нужен.
 *
 * Usage: node scripts/src/check-ai-settings-ui.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn, signInBrowser, setBrowserCookies } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const port = Number(process.env.CDP_PORT ?? 9461);
const stubPort = Number(process.env.STUB_PORT ?? 5201);
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const session = await signIn(api);
const call = async (method, route, body, cookie = session.cookieHeader) => {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: {
      cookie,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// ------------------------------------------------------------------- заглушка
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let payload = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "stub",
        object: "chat.completion",
        model: payload?.model ?? "stub",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Связь есть, всё в порядке" },
          },
        ],
      }),
    );
  });
});
await new Promise((resolve) => stub.listen(stubPort, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stubPort}/v1`;

// Сотрудник для проверки скрытого пункта меню.
const suffix = Date.now();
const staffName = `staff${suffix}`;
const staffPassword = "staff-password-123";
const created = await call("POST", "/api/users", {
  username: staffName,
  displayName: "Проверка меню",
  password: staffPassword,
  role: "staff",
});
const staffSession = await signIn(api, staffName, staffPassword);

const profile = mkdtempSync(path.join(tmpdir(), "dsh-settings-ui-"));
const browser = spawn(
  process.env.EDGE_PATH ?? "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
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
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 250));
    return result.result?.value;
  };
  const setInput = async (id, value) => {
    const set = await evaluate(`(() => {
      const input = document.getElementById(${JSON.stringify(id)});
      if (!input) return 'нет поля';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const previous = input.value;
      setter.call(input, ${JSON.stringify(String(value))});
      const tracker = input._valueTracker;
      if (tracker) tracker.setValue(previous);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return input.value;
    })()`);
    await sleep(250);
    return set;
  };
  const clickByText = async (text) => {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((node) => (node.textContent || '').trim() === ${JSON.stringify(text)});
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await sleep(1500);
    return clicked;
  };

  await cdp.send("Page.enable");
  await cdp.send("Page.navigate", { url: `${ui}/settings` });
  await cdp.send("Network.enable");
  await cdp.send("Page.navigate", { url: `${ui}/settings` });
  await sleep(3000);

  console.log("=== 1. Страница закрыта без входа ===");
  const anonymous = await evaluate(`(() => ({
    path: window.location.pathname,
    hasLogin: /Вход|Пароль/.test(document.body.innerText),
  }))()`);
  record(
    "без сессии открывается вход, а не настройки",
    anonymous?.hasLogin === true || anonymous?.path === "/login",
    JSON.stringify(anonymous),
  );

  console.log("=== 2. Администратор видит настройки ===");
  await signInBrowser(cdp, api);
  await cdp.send("Page.navigate", { url: `${ui}/settings` });
  await sleep(4000);
  const page = await evaluate(`(() => {
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const menuLinks = [...document.querySelectorAll('nav a')].map((node) => node.textContent.trim());
    const links = [...document.querySelectorAll('aside a')];
    const settingsLink = links.find((node) => (node.textContent || '').trim() === 'Настройки');
    // Настройки должны быть не в списке меню, а в нижнем блоке с учётной записью.
    const inMenu = Boolean(settingsLink && settingsLink.closest('nav'));
    const accountBlock = settingsLink
      ? settingsLink.closest('div.border-t') ?? settingsLink.parentElement
      : null;
    return {
      path: window.location.pathname,
      hasTitle: /Настройки/.test(text),
      hasBaseUrl: Boolean(document.getElementById('ai-base-url')),
      hasModel: Boolean(document.getElementById('ai-model')),
      hasSave: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Сохранить'),
      hasTest: [...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Проверить связь'),
      keyType: document.getElementById('ai-key')?.getAttribute('type') ?? null,
      hasSwitch: Boolean(document.getElementById('ai-use-own')),
      hasPlatformCard: /Общий провайдер сервиса/.test(text),
      menuLinks,
      settingsInMenu: inMenu,
      settingsInAccountBlock: Boolean(settingsLink && !inMenu && accountBlock),
      settingsHref: settingsLink?.getAttribute('href') ?? null,
      accountBlockHasUser: /Администратор|Сотрудник/.test(accountBlock?.innerText ?? ''),
      accountBlockHasLogout: Boolean(accountBlock?.querySelector('button[aria-label="Выйти"]')),
      status: text.slice(0, 400),
    };
  })()`);
  console.log("  страница:", JSON.stringify(page));
  record("страница настроек открылась", page?.hasTitle === true, JSON.stringify(page)?.slice(0, 150));
  record(
    "есть переключатель своего провайдера и сведения об общем",
    page?.hasSwitch === true && page?.hasPlatformCard === true,
    JSON.stringify({ switch: page?.hasSwitch, platformCard: page?.hasPlatformCard }),
  );
  record(
    "настройки убраны из общего меню",
    (page?.menuLinks ?? []).length > 0 && !(page?.menuLinks ?? []).includes("Настройки"),
    JSON.stringify(page?.menuLinks),
  );
  record(
    "настройки стоят внизу, в блоке с учётной записью",
    page?.settingsInAccountBlock === true,
    JSON.stringify({
      inMenu: page?.settingsInMenu,
      inAccountBlock: page?.settingsInAccountBlock,
    }),
  );
  record(
    "в том же блоке — имя пользователя и выход",
    page?.accountBlockHasUser === true && page?.accountBlockHasLogout === true,
    JSON.stringify({
      user: page?.accountBlockHasUser,
      logout: page?.accountBlockHasLogout,
    }),
  );
  record(
    "меню администратора без «Настроек» содержит рабочие разделы",
    ["Сводка", "Склад", "Букеты", "Операции", "Аналитика", "AI Ассистент", "Сотрудники"].every(
      (label) => (page?.menuLinks ?? []).includes(label),
    ),
    JSON.stringify(page?.menuLinks),
  );
  record(
    "есть кнопки сохранения и проверки связи",
    page?.hasSave === true && page?.hasTest === true,
    JSON.stringify({ save: page?.hasSave, test: page?.hasTest }),
  );
  record(
    "ссылка «Настройки» ведёт на свой адрес",
    (page?.settingsHref ?? "") === "/settings",
    String(page?.settingsHref),
  );

  console.log("=== 3. Свой провайдер магазина из формы ===");
  // Поля своего провайдера появляются только после включения галочки: по
  // умолчанию магазин работает на общем провайдере сервиса.
  const ownHiddenBefore = await evaluate(`(() => ({
    baseUrlField: Boolean(document.getElementById('ai-base-url')),
    card: /Общий провайдер сервиса/.test(document.body.innerText),
    badge: /Работает общий провайдер сервиса|Провайдер не настроен/.test(document.body.innerText),
  }))()`);
  record(
    "по умолчанию показан общий провайдер сервиса, полей магазина нет",
    ownHiddenBefore?.baseUrlField === false && ownHiddenBefore?.card === true,
    JSON.stringify(ownHiddenBefore),
  );
  await evaluate(`(() => {
    const box = document.getElementById('ai-use-own');
    if (!box) return false;
    box.click();
    return true;
  })()`);
  await sleep(600);
  const ownVisible = await evaluate(
    `(() => ({ baseUrlField: Boolean(document.getElementById('ai-base-url')), keyType: document.getElementById('ai-key')?.getAttribute('type') ?? null, help: /расходы на ассистента/.test(document.body.innerText) }))()`,
  );
  record(
    "после включения появились поля своего провайдера",
    ownVisible?.baseUrlField === true,
    JSON.stringify(ownVisible),
  );
  record(
    "поле ключа скрывает ввод",
    ownVisible?.keyType === "password",
    String(ownVisible?.keyType),
  );
  await setInput("ai-base-url", stubUrl);
  await setInput("ai-key", "ui-secret-key-4321");
  await setInput("ai-model", "ui-model");
  await clickByText("Сохранить");
  await sleep(1500);
  const saved = await call("GET", "/api/settings/ai");
  record(
    "свой провайдер сохранён со страницы",
    saved.body?.shopBaseUrl === stubUrl && saved.body?.shopModel === "ui-model" && saved.body?.source === "shop",
    JSON.stringify({ baseUrl: saved.body?.shopBaseUrl, model: saved.body?.shopModel, source: saved.body?.source }),
  );
  record(
    "ключ магазина сохранён и показан только окончанием",
    saved.body?.shopKeySet === true && String(saved.body?.keySuffix).endsWith("4321"),
    JSON.stringify({ shopKeySet: saved.body?.shopKeySet, keySuffix: saved.body?.keySuffix }),
  );
  const afterSave = await evaluate(`(() => ({
    keyValue: document.getElementById('ai-key')?.value ?? null,
    text: document.body.innerText.replace(/\\s+/g, ' ').slice(0, 500),
  }))()`);
  record(
    "поле ключа очищено после сохранения",
    (afterSave?.keyValue ?? "") === "",
    JSON.stringify(afterSave?.keyValue),
  );
  record(
    "на странице видно, что ключ сохранён",
    /сохранён|••••4321/.test(afterSave?.text ?? "") || (afterSave?.text ?? "").includes("4321"),
    (afterSave?.text ?? "").slice(0, 200),
  );

  console.log("=== 4. Проверка связи показывает ответ провайдера ===");
  await clickByText("Проверить связь");
  await sleep(2500);
  const checked = await evaluate(`(() => {
    const status = document.querySelector('[role="status"]');
    return { text: (status?.innerText ?? '').replace(/\\s+/g, ' ').trim(), body: document.body.innerText.replace(/\\s+/g, ' ') };
  })()`);
  console.log("  проверка:", JSON.stringify(checked)?.slice(0, 260));
  record(
    "на странице виден ответ провайдера",
    /Связь есть|stub|ui-model/.test(checked?.text ?? ""),
    JSON.stringify(checked)?.slice(0, 200),
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-ai-settings.png", shot.data);

  console.log("=== 5. Сотруднику настройки не показываются ===");
  // Ставим cookie сотрудника: страница должна закрыться, а пункта меню быть не должно.
  await setBrowserCookies(cdp, api, staffSession.cookies);
  await cdp.send("Page.navigate", { url: `${ui}/settings` });
  await sleep(4000);
  const staffView = await evaluate(`(() => {
    const text = document.body.innerText.replace(/\\s+/g, ' ');
    const nav = [...document.querySelectorAll('nav a, aside a')].map((node) => node.textContent.trim());
    return {
      path: window.location.pathname,
      hasSettingsForm: Boolean(document.getElementById('ai-base-url')),
      hasSettingsNav: nav.some((label) => label.includes("Настройки")),
      text: text.slice(0, 200),
    };
  })()`);
  console.log("  сотрудник:", JSON.stringify(staffView));
  record(
    "сотрудник не видит пункт «Настройки»",
    staffView?.hasSettingsNav === false,
    JSON.stringify(staffView?.nav ?? staffView),
  );
  record(
    "форма настроек сотруднику не показывается",
    staffView?.hasSettingsForm === false,
    JSON.stringify(staffView)?.slice(0, 200),
  );

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-ai-settings-staff.png"),
    Buffer.from(mobileShot.data, "base64"),
  );

  socket.close();
} catch (error) {
  record("проверка экрана настроек", false, String(error).slice(0, 300));
} finally {
  browser.kill();
  // Убираем за собой: тестовый сотрудник и настройки не должны оставаться.
  await call("PATCH", `/api/users/${created.body?.id}`, { isActive: false });
  await call("PUT", "/api/settings/ai", { provider: "platform" });
  stub.close();
  await sleep(800);
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    // уберёт система
  }
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
