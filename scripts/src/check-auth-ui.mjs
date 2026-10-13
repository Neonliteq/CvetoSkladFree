/**
 * Verifies the sign-in flow in the real UI and the role-dependent navigation.
 *
 * Usage: node scripts/src/check-auth-ui.mjs [width] [height]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { adminPassword, adminUsername } from "./credentials.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 1440);
const height = Number(process.argv[3] ?? 1000);
const base = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const port = 9346;

const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-auth-ui-"));

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

const pageState = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      const text = document.body.innerText.replace(/\\s+/g, ' ');
      const nav = [...document.querySelectorAll('nav a')].map((a) => a.textContent.trim());
      return {
        url: window.location.pathname,
        hasLoginForm: Boolean(document.querySelector('#username') && document.querySelector('#password')),
        hasPinPad: text.includes('введите PIN') || Boolean(document.querySelector('[aria-label="Введённые цифры"]')),
        heading: document.querySelector('h1')?.textContent?.trim() ?? null,
        nav,
        signedInAs: text.includes('Администратор')
          ? 'Администратор'
          : text.includes('Сотрудник')
            ? 'Сотрудник'
            : null,
        error: document.querySelector('[role=alert]')?.textContent?.trim() ?? null,
        // Diagnostics: the last few requests the page made and their statuses.
        recent: (window.__recent ?? []).slice(-8),
        text: text.slice(0, 160),
      };
    })()`,
  );

/**
 * Types into a field the way a user does.
 *
 * Setting `input.value` directly does not reach React state, so the two-step
 * flows (wrong password, then the right one) silently submitted the old value.
 */
const typeInto = async (cdp, selector, value) => {
  const focused = await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector(${JSON.stringify(selector)});
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    })()`,
  );
  if (!focused) return false;
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
  await cdp.send("Input.insertText", { text: value });
  await sleep(200);
  return true;
};

const clickByText = (cdp, text) =>
  evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button, a')].find((element) =>
        (element.textContent ?? '').trim().includes(${JSON.stringify(text)}),
      );
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );

/** For icon-only controls, which carry a label instead of text. */
const clickByAria = (cdp, label) =>
  evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('button[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']');
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );

const results = [];
const record = (label, ok, detail) => results.push([label, Boolean(ok), detail]);

seedDatabase();

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  await cdp.send("Page.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `
      window.__recent = [];
      const originalFetch = window.fetch;
      window.fetch = async (...args) => {
        const url = typeof args[0] === 'string' ? args[0] : args[0]?.url;
        const method = (args[1]?.method ?? 'GET').toUpperCase();
        try {
          const response = await originalFetch(...args);
          if (String(url).includes('/api/auth/login')) {
            const copy = response.clone();
            const body = await copy.text().catch(() => '');
            window.__recent.push('LOGIN ' + response.status + ' ' + body.slice(0, 90));
          } else if (!response.ok) {
            window.__recent.push(response.status + ' ' + String(url));
          }
          return response;
        } catch (error) {
          window.__recent.push('ERR ' + method + ' ' + String(url));
          throw error;
        }
      };
    `,
  });
  await cdp.send("Page.navigate", { url: `${base}/products` });
  await sleep(3500);

  // ------------------------------------------------------------- not signed in
  const anonymous = await pageState(cdp);
  console.log("anonymous:", JSON.stringify(anonymous));
  record("an anonymous visitor gets the sign-in form", anonymous.hasLoginForm, anonymous.text);
  record(
    "the protected page is not rendered without a session",
    anonymous.heading === null || !anonymous.text.includes("Управление каталогом"),
  );

  // -------------------------------------------------------------- wrong password
  await typeInto(cdp, "#username", adminUsername);
  await typeInto(cdp, "#password", "неверный-пароль-1");
  await clickByText(cdp, "Войти");
  await sleep(2500);
  const rejected = await pageState(cdp);
  console.log("rejected:", JSON.stringify(rejected.error));
  record("a wrong password shows an error", Boolean(rejected.error), rejected.error);
  record("the user stays on the sign-in form", rejected.hasLoginForm);

  // -------------------------------------------------------------------- sign in
  await typeInto(cdp, "#password", adminPassword);
  await clickByText(cdp, "Войти");

  let signedIn = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await sleep(1000);
    signedIn = await pageState(cdp);
    if (!signedIn.hasLoginForm) break;
  }
  console.log("signed in:", JSON.stringify(signedIn));
  record("signing in opens the app", !signedIn.hasLoginForm, signedIn.text);
  record(
    "the app returns to the page that was requested",
    signedIn.url === "/products",
    signedIn.url,
  );
  record(
    "an administrator sees the staff section",
    signedIn.nav.includes("Сотрудники"),
    signedIn.nav.join(", "),
  );
  record(
    "the signed-in user is shown with a role",
    String(signedIn.signedInAs).includes("Администратор"),
    signedIn.signedInAs,
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-auth-desktop.png", shot.data);

  // -------------------------------------------------------------- users screen
  await cdp.send("Page.navigate", { url: `${base}/users` });
  await sleep(2500);
  const users = await evaluate(
    cdp,
    `(() => {
      const text = document.body.innerText.replace(/\\s+/g, ' ');
      return {
        heading: document.querySelector('h1')?.textContent?.trim() ?? null,
        hasAdmin: text.includes(${JSON.stringify(adminUsername)}),
        hasCreate: text.includes('Добавить сотрудника'),
        hasDevice: text.includes('Доверить этот браузер'),
        hasRoles: text.includes('администратор'),
        hasMessengerLink: Boolean(document.querySelector('#link-code')),
        hasMessengerExplanation: text.includes('Telegram или MAX'),
      };
    })()`,
  );
  console.log("users screen:", JSON.stringify(users));
  record("the staff screen opens for an administrator", users.heading === "Сотрудники", users.heading);
  record("the account list is rendered", users.hasAdmin);
  record("the screen offers adding a colleague", users.hasCreate);
  record("the screen offers trusting this device", users.hasDevice);
  record("the administrator role is visible", users.hasRoles);
  record("the screen offers linking a messenger", users.hasMessengerLink);
  record("the linking field is explained", users.hasMessengerExplanation);

  const usersShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-auth-users.png"),
    Buffer.from(usersShot.data, "base64"),
  );

  // -------------------------------------------------------------------- sign out
  const signOutClicked = await clickByAria(cdp, "Выйти");
  record("the sign-out control is reachable", signOutClicked);
  // Signing out reloads the page, so the app boots again from `/auth/me`.
  await sleep(4000);
  await cdp.send("Page.navigate", { url: `${base}/users` });
  await sleep(3000);
  const afterLogout = await pageState(cdp);
  console.log("after logout:", JSON.stringify(afterLogout));
  record("signing out returns to the sign-in form", afterLogout.hasLoginForm, afterLogout.text);

  await cdp.send("Page.navigate", { url: `${base}/movements` });
  await sleep(2500);
  const afterLogoutNavigation = await pageState(cdp);
  record(
    "a protected page cannot be opened after signing out",
    afterLogoutNavigation.hasLoginForm,
    afterLogoutNavigation.text,
  );

  // ------------------------------------------------------- a staff account's view
  const suffix = Date.now().toString().slice(-6);
  const staffName = `worker${suffix}`;
  const staffPassword = "Sklad2026pass";

  const adminLogin = await fetch(`${api}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  const adminCookie = (adminLogin.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(";")[0])
    .join("; ");
  await fetch(`${api}/api/users`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: adminCookie },
    body: JSON.stringify({
      username: staffName,
      displayName: "Работник склада",
      password: staffPassword,
      role: "staff",
    }),
  });

  await cdp.send("Page.navigate", { url: `${base}/login` });
  await sleep(2000);
  await typeInto(cdp, "#username", staffName);
  await typeInto(cdp, "#password", staffPassword);
  await clickByText(cdp, "Войти");

  let staffState = null;
  for (let attempt = 0; attempt < 25; attempt += 1) {
    await sleep(1000);
    staffState = await pageState(cdp);
    if (!staffState.hasLoginForm) break;
  }
  console.log("staff:", JSON.stringify(staffState));
  record("a worker can sign in", !staffState.hasLoginForm, staffState.text);
  record(
    "a worker does not see the staff section",
    !staffState.nav.includes("Сотрудники"),
    staffState.nav.join(", "),
  );
  record(
    "a worker is shown as a worker",
    String(staffState.signedInAs).includes("Сотрудник"),
    staffState.signedInAs,
  );

  await cdp.send("Page.navigate", { url: `${base}/users` });
  await sleep(2500);
  const staffOnUsers = await pageState(cdp);
  record(
    "a worker cannot open the staff screen by address",
    !String(staffOnUsers.text).includes("Доверить этот браузер"),
    staffOnUsers.text,
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
