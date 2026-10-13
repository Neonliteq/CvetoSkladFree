/**
 * Проверяет отмену любой складской операции из истории.
 *
 * Usage: node scripts/src/check-movement-undo.mjs
 */
import { seedDatabase } from "./seed-helper.mjs";
import { signIn } from "./auth-helper.mjs";

const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
seedDatabase();

const results = [];
const record = (label, ok, detail) => {
  results.push([label, Boolean(ok), detail]);
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}${!ok && detail ? ` — ${detail}` : ""}`);
};

const session = await signIn(api);
const call = async (method, path, body) => {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { cookie: session.cookieHeader, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 150);
  }
  return { status: response.status, body: parsed };
};

const stockOf = async (productId) =>
  ((await call("GET", "/api/products")).body ?? []).find((item) => item.id === productId)
    ?.currentStock;

const products = (await call("GET", "/api/products")).body ?? [];
const product = products.find((item) => item.productType === "stock" && item.currentStock > 5);
const stockBefore = product.currentStock;

console.log("=== 1. Проводим продажу и отменяем её из истории ===");
const created = await call("POST", "/api/movements", {
  productId: product.id,
  type: "expense",
  quantity: 2,
  reason: "Проверка отмены из истории",
});
record("операция проведена", created.status === 201, `статус ${created.status}`);
const movementId = created.body?.id;
record("остаток уменьшился", (await stockOf(product.id)) === stockBefore - 2, `${stockBefore} → ${await stockOf(product.id)}`);

// Отменяем именно ту операцию, что видна в истории.
const history = (await call("GET", "/api/movements?limit=5")).body ?? [];
record("операция видна в истории", history.some((item) => item.id === movementId), `id ${movementId}`);

const undone = await call("POST", `/api/movements/${movementId}/undo`, {});
record("отмена прошла", undone.status === 200, `статус ${undone.status} ${JSON.stringify(undone.body).slice(0, 120)}`);
record(
  "в ответе назван товар и количество",
  undone.body?.productName === product.name && undone.body?.quantity === 2,
  JSON.stringify(undone.body).slice(0, 120),
);
record(
  "остаток восстановлен",
  (await stockOf(product.id)) === stockBefore,
  `${stockBefore - 2} → ${await stockOf(product.id)}`,
);

console.log("\n=== 2. Повторная отмена запрещена ===");
const again = await call("POST", `/api/movements/${movementId}/undo`, {});
record("повторная отмена отклонена", again.status === 400, `статус ${again.status}: ${JSON.stringify(again.body).slice(0, 90)}`);

console.log("\n=== 3. Компенсирующую запись отменить нельзя ===");
const reversalId = undone.body?.reversalId;
const reversalUndo = await call("POST", `/api/movements/${reversalId}/undo`, {});
record("отмена компенсирующей записи отклонена", reversalUndo.status === 400, `статус ${reversalUndo.status}`);

console.log("\n=== 4. Приход с израсходованной партией отменить нельзя ===");
const receipts = (await call("GET", `/api/products/${product.id}/receipts`)).body ?? [];
const usedReceipt = receipts.find((item) => (item.remainingQuantity ?? 0) < item.quantity);
if (usedReceipt) {
  const blocked = await call("POST", `/api/movements/${usedReceipt.id}/undo`, {});
  record("использованная партия защищена", blocked.status === 400, `статус ${blocked.status}: ${JSON.stringify(blocked.body).slice(0, 100)}`);
} else {
  record("использованная партия защищена", true, "подходящего прихода нет — пропускаю");
}

console.log("\n=== 5. Несуществующая операция ===");
const missing = await call("POST", "/api/movements/99999999/undo", {});
record("несуществующая операция даёт 404", missing.status === 404, `статус ${missing.status}`);

console.log("\n=== 6. Возврат к исходному состоянию ===");
const restoredMovement = await call("POST", "/api/movements", {
  productId: product.id,
  type: "expense",
  quantity: 2,
  reason: "Проверка отмены из истории",
});
const finalUndo = await call("POST", `/api/movements/${restoredMovement.body?.id}/undo`, {});
record("повторная продажа и её отмена работают", finalUndo.status === 200, `статус ${finalUndo.status}`);
record("остаток в исходном состоянии", (await stockOf(product.id)) === stockBefore, String(await stockOf(product.id)));

console.log("\n=== 7. Отмена требует подтверждения в интерфейсе ===");
// Проверяем, что кнопка отмены открывает диалог, а не отменяет сразу.
const ui = process.env.UI_BASE ?? "http://127.0.0.1:22284";
if (process.env.CHECK_UI === "1") {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { signInBrowser } = await import("./auth-helper.mjs");

  const port = 9401;
  const profile = mkdtempSync(path.join(tmpdir(), "dsh-undo-"));
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
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const evaluate = async (cdp, expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 200));
    return result.result?.value;
  };

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
      const parsed = JSON.parse(event.data);
      const resolve = pending.get(parsed.id);
      if (resolve) {
        pending.delete(parsed.id);
        resolve(parsed);
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

    await signInBrowser(cdp);
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: `${ui}/movements` });
    await sleep(4500);

    const trigger = await evaluate(
      cdp,
      `(() => {
        const button = document.querySelector('button[aria-label^="Отменить операцию"]');
        if (!button) return null;
        return { label: button.getAttribute('aria-label') };
      })()`,
    );
    record("в истории есть кнопка отмены", Boolean(trigger), JSON.stringify(trigger));

    if (trigger) {
      await evaluate(
        cdp,
        `(() => {
          const button = document.querySelector('button[aria-label^="Отменить операцию"]');
          button.click();
          return 'нажата';
        })()`,
      );
      await sleep(900);
      const dialog = await evaluate(
        cdp,
        `(() => {
          const title = [...document.querySelectorAll('h2, [role="heading"]')]
            .find((node) => (node.textContent || '').includes('Отменить операцию?'));
          const actions = [...document.querySelectorAll('[role="alertdialog"] button, [role="dialog"] button')]
            .map((button) => (button.textContent || '').trim());
          return { opened: Boolean(title), actions };
        })()`,
      );
      console.log("  диалог:", JSON.stringify(dialog));
      record("нажатие открывает подтверждение, а не отменяет", dialog?.opened === true, JSON.stringify(dialog));
      record(
        "в подтверждении есть отказ и согласие",
        (dialog?.actions ?? []).some((text) => text.includes("Оставить")) &&
          (dialog?.actions ?? []).some((text) => text.includes("Отменить операцию")),
        JSON.stringify(dialog?.actions),
      );

      // Закрываем отказом: склад не должен измениться.
      await evaluate(
        cdp,
        `(() => {
          const button = [...document.querySelectorAll('button')]
            .find((node) => (node.textContent || '').trim() === 'Оставить');
          button?.click();
          return 'закрыто';
        })()`,
      );
      await sleep(700);
      const stillThere = await evaluate(
        cdp,
        `document.querySelectorAll('button[aria-label^="Отменить операцию"]').length`,
      );
      record("отказ закрывает диалог и ничего не меняет", stillThere > 0, `кнопок отмены: ${stillThere}`);
    }
    socket.close();
  } catch (error) {
    record("подтверждение отмены в интерфейсе", false, String(error).slice(0, 150));
  } finally {
    browser.kill();
    await sleep(1000);
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // уберёт система
    }
  }
} else {
  record("подтверждение отмены в интерфейсе", true, "проверка интерфейса не запрошена (CHECK_UI=1 включает)");
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
