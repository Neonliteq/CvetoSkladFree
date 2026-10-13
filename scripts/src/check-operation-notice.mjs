/**
 * Проверяет, что уведомление об операции говорит, что именно провели.
 *
 * «Операция успешно проведена» нельзя проверить — она одинакова для всего.
 * Поэтому проверка ловит всплывающее окно и требует в нём вид операции, товар,
 * количество с единицей и деньги, а для списания вне статистики — пометку.
 *
 * Usage: node scripts/src/check-operation-notice.mjs
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signInBrowser, signIn } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

const here = path.dirname(fileURLToPath(import.meta.url));
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const port = Number(process.env.CDP_PORT ?? 9457);
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const session = await signIn(api);
const apiCall = async (method, route, body) => {
  const response = await fetch(`${api}${route}`, {
    method,
    headers: {
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// Товар с известными ценой и единицей: по ним и сверяем текст уведомления.
const products = (await apiCall("GET", "/api/products")).body ?? [];
const product = products.find(
  (item) => item.productType === "stock" && item.currentStock >= 5 && item.unit === "стебель",
);
if (!product) throw new Error("В демо-данных нет товара в стеблях с остатком");
console.log(`  товар: ${product.name}, ${product.currentStock} ${product.unit}, продажа ${product.salePrice} ₽`);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = mkdtempSync(path.join(tmpdir(), "dsh-notice-"));
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
  const requests = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.method === "Network.requestWillBeSent") {
      const request = message.params.request;
      if (request.method === "POST" && String(request.url).includes("/movements")) {
        requests.push(request.postData ?? "");
      }
    }
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
    if (result.exceptionDetails) {
      throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 250));
    }
    return result.result?.value;
  };

  await signInBrowser(cdp);
  await cdp.send("Page.enable");
  await cdp.send("Network.enable");
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(5000);

  const openDialog = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((node) => (node.textContent || '').trim() === 'Новая операция');
        button?.click();
        return true;
      })()`);
      await sleep(1200);
      const ready = await evaluate(
        `Boolean([...document.querySelectorAll('[role="dialog"]')]
           .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции')))`,
      );
      if (ready) return true;
      await sleep(400);
    }
    return false;
  };

  const pickType = async (label) => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const picked = await evaluate(`(() => {
        const group = document.querySelector('[role="group"][aria-label="Тип операции"]');
        if (!group) return false;
        const button = [...group.querySelectorAll('button')]
          .find((node) => node.textContent.trim() === ${JSON.stringify(label)});
        if (!button) return false;
        button.click();
        return true;
      })()`);
      if (picked) {
        await sleep(700);
        return true;
      }
      await sleep(300);
    }
    return false;
  };

  const pickProduct = async (name) => {
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      dialog.querySelector('button[role="combobox"]').click();
      return true;
    })()`);
    await sleep(900);
    const picked = await evaluate(`(() => {
      const option = [...document.querySelectorAll('[role="option"]')]
        .find((node) => (node.textContent || '').includes(${JSON.stringify(name)}));
      if (!option) return false;
      option.click();
      return true;
    })()`);
    await sleep(800);
    // Список Radix закрывается не всегда: с открытым списком нажатие до кнопки
    // «Провести» не доходит.
    if (await evaluate(`document.querySelectorAll('[role="option"]').length`)) {
      await evaluate(`(() => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        return true;
      })()`);
      await sleep(500);
    }
    return picked;
  };

  const setQuantity = async (value) => {
    const set = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      const input = [...dialog.querySelectorAll('input[type="number"]')]
        .find((node) => node.offsetParent !== null);
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const previous = input.value;
      setter.call(input, ${JSON.stringify(String(value))});
      const tracker = input._valueTracker;
      if (tracker) tracker.setValue(previous);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.blur();
      return input.value;
    })()`);
    await sleep(300);
    return set;
  };

  /** Заполняет поле по подписи: для цены закупки в приходе. */
  const setFieldByLabel = async (label, value) => {
    const set = await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      // Ищем по связи label → input через htmlFor: поиск «по предку» попадает в
      // соседнее поле, и цена уходила в количество.
      const labelNode = [...dialog.querySelectorAll('label')]
        .find((node) => (node.textContent || '').replace(/\\s+/g, ' ').trim().startsWith(${JSON.stringify(label)}));
      if (!labelNode) return 'нет подписи';
      const field = labelNode.htmlFor
        ? dialog.querySelector('#' + CSS.escape(labelNode.htmlFor))
        : labelNode.parentElement?.querySelector('input');
      if (!field) return 'нет поля';
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      const previous = field.value;
      setter.call(field, ${JSON.stringify(String(value))});
      const tracker = field._valueTracker;
      if (tracker) tracker.setValue(previous);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new Event('change', { bubbles: true }));
      field.blur();
      return field.value;
    })()`);
    await sleep(300);
    return set;
  };

  const submit = async () => {
    requests.length = 0;
    await evaluate(`(() => {
      const dialog = [...document.querySelectorAll('[role="dialog"]')]
        .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
      const button = [...dialog.querySelectorAll('button')]
        .find((node) => (node.textContent || '').trim() === 'Провести');
      button.click();
      return true;
    })()`);
    await sleep(3000);
  };

  /** Текст последнего всплывающего уведомления. */
  const lastNotice = async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const notice = await evaluate(`(() => {
        const items = [...document.querySelectorAll('[data-sonner-toast]')];
        if (!items.length) return null;
        const last = items[items.length - 1];
        const title = last.querySelector('[data-title]')?.textContent?.trim() ?? '';
        const description = last.querySelector('[data-description]')?.textContent?.trim() ?? '';
        return { title, description, text: (last.innerText || '').replace(/\\s+/g, ' ').trim() };
      })()`);
      if (notice?.description) return notice;
      await sleep(200);
    }
    return null;
  };

  const waitForNoticeGone = async () => {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const count = await evaluate(`document.querySelectorAll('[data-sonner-toast]').length`);
      if (!count) return true;
      // Закрываем сами: ждать шесть секунд на каждое уведомление долго.
      await evaluate(`(() => {
        const button = document.querySelector('[data-sonner-toast] [data-close-button]');
        button?.click();
        return true;
      })()`);
      await sleep(250);
    }
    return false;
  };

  console.log("\n=== 1. Уведомление о продаже ===");
  record("окно операции открылось", (await openDialog()) === true, "окно не найдено");
  await pickType("Продажа");
  record("товар выбран", (await pickProduct(product.name)) === true, product.name);
  await setQuantity(2);
  await submit();
  const saleNotice = await lastNotice();
  const saleSent = requests.length ? JSON.parse(requests[requests.length - 1]) : null;
  console.log("  уведомление:", JSON.stringify(saleNotice));
  console.log("  запрос:", JSON.stringify(saleSent));
  record("продажа ушла на сервер", saleSent?.type === "expense", JSON.stringify(saleSent));
  record(
    "в уведомлении назван вид операции",
    /Продажа/i.test(saleNotice?.title ?? "") || /Продажа/i.test(saleNotice?.description ?? ""),
    JSON.stringify(saleNotice),
  );
  record(
    "в уведомлении назван товар и количество с единицей",
    (saleNotice?.description ?? "").includes(product.name) &&
      (saleNotice?.description ?? "").includes(`−2 ${product.unit}`),
    JSON.stringify(saleNotice),
  );
  record(
    "в уведомлении есть цена продажи",
    (saleNotice?.description ?? "").includes("₽"),
    JSON.stringify(saleNotice),
  );
  await waitForNoticeGone();

  console.log("\n=== 2. Уведомление о списании вне статистики ===");
  await openDialog();
  await pickType("Списание");
  await pickProduct(product.name);
  await setQuantity(1);
  await evaluate(`(() => {
    const dialog = [...document.querySelectorAll('[role="dialog"]')]
      .find((node) => (node.querySelector('h2')?.textContent || '').includes('Проведение операции'));
    dialog.querySelector('input[type="checkbox"][aria-label="Не учитывать операцию в статистике"], button[role="checkbox"][aria-label="Не учитывать операцию в статистике"]').click();
    return true;
  })()`);
  await sleep(400);
  await submit();
  const writeoffNotice = await lastNotice();
  console.log("  уведомление:", JSON.stringify(writeoffNotice));
  record(
    "в уведомлении о списании назван вид и товар",
    /Списание/i.test(`${writeoffNotice?.title} ${writeoffNotice?.description}`) &&
      (writeoffNotice?.description ?? "").includes(product.name),
    JSON.stringify(writeoffNotice),
  );
  record(
    "пометка «не в статистике» попала в уведомление",
    (writeoffNotice?.description ?? "").includes("не в статистике"),
    JSON.stringify(writeoffNotice),
  );
  await waitForNoticeGone();

  console.log("\n=== 3. Уведомление о приходе ===");
  await openDialog();
  await pickType("Приход");
  await pickProduct(product.name);
  await setQuantity(3);
  // В приходе цену закупки вводит кладовщик: проверяем, что в уведомлении
  // окажется именно она, а не подставленная сервером по умолчанию.
  const price = await setFieldByLabel("Цена за единицу", 100);
  record("цена закупки введена", price === "100", String(price));
  await submit();
  const receiptNotice = await lastNotice();
  const receiptSent = requests.length ? JSON.parse(requests[requests.length - 1]) : null;
  console.log("  уведомление:", JSON.stringify(receiptNotice));
  console.log("  запрос:", JSON.stringify(receiptSent));
  record(
    "в запросе цена, которую ввёл кладовщик",
    receiptSent?.unitPrice === 100,
    JSON.stringify(receiptSent),
  );
  record(
    "в уведомлении о приходе есть «+3», цена и сумма",
    (receiptNotice?.description ?? "").includes(`+3 ${product.unit}`) &&
      (receiptNotice?.description ?? "").includes("100 ₽") &&
      (receiptNotice?.description ?? "").includes("300 ₽"),
    JSON.stringify(receiptNotice),
  );

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-operation-notice.png", shot.data);

  console.log("\n=== 4. Уведомление на телефоне ===");
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await cdp.send("Page.navigate", { url: `${ui}/movements` });
  await sleep(4500);
  await openDialog();
  await pickType("Продажа");
  await pickProduct(product.name);
  await setQuantity(1);
  await submit();
  const mobile = await evaluate(`(() => {
    const item = [...document.querySelectorAll('[data-sonner-toast]')].pop();
    if (!item) return null;
    const rect = item.getBoundingClientRect();
    return {
      text: (item.innerText || '').replace(/\\s+/g, ' ').trim(),
      width: Math.round(rect.width),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
  console.log("  на телефоне:", JSON.stringify(mobile));
  record(
    "на телефоне уведомление содержит товар и количество",
    (mobile?.text ?? "").includes(product.name) && (mobile?.text ?? "").includes(product.unit),
    JSON.stringify(mobile),
  );
  record(
    "уведомление не вылезает за экран",
    (mobile?.left ?? 0) >= 0 && (mobile?.right ?? 999) <= 390,
    JSON.stringify(mobile),
  );

  const mobileShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-operation-notice-mobile.png"),
    Buffer.from(mobileShot.data, "base64"),
  );

  socket.close();
} catch (error) {
  record("проверка уведомления об операции", false, String(error).slice(0, 300));
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
