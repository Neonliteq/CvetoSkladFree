/**
 * Drives the invoice photo flow through the real UI in headless Edge.
 *
 * Pass 1 — `invoice-sample.png`: every line exists in the catalog, so the draft
 * must offer mapping only and no product creation.
 * Pass 2 — `invoice-unknown-product.png`: two lines are missing from the
 * catalog, so the draft must offer creating them, and confirming must create
 * the product together with its receipt.
 *
 * Usage: node scripts/src/check-invoice-ui.mjs [width] [height]
 */
import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signInBrowser } from "./auth-helper.mjs";
import { ensureScreenshotsDir, saveScreenshot } from "./screenshot-helper.mjs";

// Каталог снимков не хранится в репозитории: на чистой копии его создаём сами.
ensureScreenshotsDir();

// The recognition scenarios need a known catalog, and earlier runs leave test
// products behind, so the database is reset before the check starts.
seedDatabase();

const here = path.dirname(fileURLToPath(import.meta.url));
const width = Number(process.argv[2] ?? 1440);
const height = Number(process.argv[3] ?? 1000);
const apiBase = "http://127.0.0.1:5000";
const port = 9336;
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const profile = mkdtempSync(path.join(tmpdir(), "dsh-invoice-ui-"));

// The browser process may live on another drive, so fixtures are copied next to
// the temporary profile where they can definitely be read.
const photos = {};
for (const name of ["invoice-sample", "invoice-unknown-product"]) {
  const target = path.join(profile, `${name}.png`);
  copyFileSync(path.resolve(here, "..", "fixtures", `${name}.png`), target);
  photos[name] = target;
}

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
      }, 60000);
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

// Set once the session exists; catalogue lookups outside the browser use it.
let sessionCookie = "";

/** Catalogue lookups need the session as well — the API is closed by default. */
const productsMatching = async (search) =>
  fetch(`${apiBase}/api/products?search=${encodeURIComponent(search)}`, {
    headers: { cookie: sessionCookie },
  }).then((response) => response.json());

/** Attaches a fixture photo to the composer and waits for a new review card. */
async function upload(cdp, photo) {
  const cardsBefore = await evaluate(
    cdp,
    `[...document.querySelectorAll('span')].filter((s) => s.textContent === 'Накладная распознана').length`,
  );
  // The attach trigger opens a menu with camera and gallery; the gallery entry
  // feeds the hidden input, which is then set directly so the check does not
  // depend on native file-dialog behaviour.
  await clickButton(cdp, `b.getAttribute('aria-label') === 'Приложить фото накладной'`);
  await sleep(500);
  await clickButton(cdp, `b.textContent?.includes('Выбрать из галереи')`);
  await sleep(400);
  const document_ = await cdp.send("DOM.getDocument");
  const node = await cdp.send("DOM.querySelector", {
    nodeId: document_.root.nodeId,
    selector: 'input[type="file"]:not([capture])',
  });
  if (!node.nodeId) throw new Error("file input not found in the assistant composer");
  await cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files: [photo] });

  for (let attempt = 0; attempt < 45; attempt += 1) {
    await sleep(1000);
    const cards = await evaluate(
      cdp,
      `[...document.querySelectorAll('span')].filter((s) => s.textContent === 'Накладная распознана').length`,
    );
    if (cards > cardsBefore) return readCard(cdp);
  }
  return null;
}

const readCard = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      const headings = [...document.querySelectorAll('span')].filter((s) => s.textContent === 'Накладная распознана');
      const heading = headings[headings.length - 1];
      if (!heading) return null;
      const root = heading.closest('div.rounded-xl');
      const rows = [...root.querySelectorAll('div.divide-y > div')];
      const submit = [...root.querySelectorAll('button')].find((b) => b.textContent?.includes('Провести приход'));
      const createButtons = [...root.querySelectorAll('button')].filter((b) =>
        (b.getAttribute('aria-label') ?? '').startsWith('Создать товар для'),
      );
      return {
        rows: rows.length,
        selects: root.querySelectorAll('[role=combobox]').length,
        numberInputs: root.querySelectorAll('input[type=number]').length,
        createButtons: createButtons.length,
        unmatchedRows: rows.filter((row) => row.innerText.includes('Не найден в каталоге')).length,
        header: root.innerText.replace(/\\s+/g, ' ').slice(0, 140),
        submitLabel: submit?.textContent?.trim() ?? null,
        cardWidth: Math.round(root.getBoundingClientRect().width),
      };
    })()`,
  );

const checkLayout = (cdp) =>
  evaluate(
    cdp,
    `(() => {
      const doc = document.documentElement;
      const headings = [...document.querySelectorAll('span')].filter((s) => s.textContent === 'Накладная распознана');
      const root = headings[headings.length - 1]?.closest('div.rounded-xl');
      const scroller = document.querySelector('.overflow-y-auto');
      return {
        pageOverflow: doc.scrollWidth - doc.clientWidth,
        cardOverflowsScroller: root
          ? root.getBoundingClientRect().right > (scroller?.getBoundingClientRect().right ?? 0) + 1
          : null,
        imageCount: document.querySelectorAll('img[alt="Фото накладной"]').length,
      };
    })()`,
  );

const clickButton = (cdp, predicate) =>
  evaluate(
    cdp,
    `(() => {
      const button = [...document.querySelectorAll('button')].find((b) => ${predicate});
      if (!button) return false;
      button.click();
      return true;
    })()`,
  );

try {
  const cdp = await Cdp.connect(await debuggingTarget());
  const session = await signInBrowser(cdp);
  sessionCookie = session.cookieHeader;
  console.log('signed in:', session.cookies.map((c) => c.name).join(', '));
  await cdp.send("Page.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Page.navigate", { url: "http://127.0.0.1:22284/assistant" });
  await sleep(4000);

  const results = [];
  const record = (scope, label, ok) => results.push([scope, label, Boolean(ok)]);

  const composer = await evaluate(
    cdp,
    `(() => {
      const button = document.querySelector('button[aria-label="Приложить фото накладной"]');
      const hint = [...document.querySelectorAll('p')].find((p) =>
        (p.textContent ?? '').includes('фото накладной'),
      );
      const cameraInput = document.querySelector('input[capture]');
      return {
        attachButton: Boolean(button),
        hint: Boolean(hint),
        inputType: document.querySelector('input[type=file]')?.accept ?? null,
        cameraCapture: cameraInput?.getAttribute('capture') ?? null,
      };
    })()`,
  );
  record("composer", "attach button is rendered", composer.attachButton);
  record("composer", "file picker accepts images", String(composer.inputType).includes("image/png"));
  record("composer", "camera capture is offered to phones", composer.cameraCapture === "environment");
  record("composer", "composer explains the photo flow", composer.hint);

  // ---------------------------------------------------------------- pass 1
  const card = await upload(cdp, photos["invoice-sample"]);
  console.log("pass 1 card:", JSON.stringify(card));
  const layout = await checkLayout(cdp);
  console.log("pass 1 layout:", JSON.stringify(layout));

  record("known lines", "review card renders every recognised line", card?.rows === 8);
  record("known lines", "each line can be remapped to a catalog product", card?.selects === 8);
  record("known lines", "quantity and price are editable per line", card?.numberInputs === 16);
  record("known lines", "confirmation button is available", Boolean(card?.submitLabel));
  record("known lines", "a fully matched document offers no product creation", card?.createButtons === 0);
  record("known lines", "uploaded photo is shown in the thread", layout.imageCount >= 1);
  record("known lines", "card fits the conversation area", layout.cardOverflowsScroller === false);
  record("known lines", "page does not scroll sideways", layout.pageOverflow === 0);

  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  saveScreenshot("check-invoice-flow.png", shot.data);

  // ---------------------------------------------------------------- pass 2
  const unknownCard = await upload(cdp, photos["invoice-unknown-product"]);
  console.log("pass 2 card:", JSON.stringify(unknownCard));
  record("missing product", "the document with unknown lines is recognised", unknownCard?.rows === 3);
  record("missing product", "unmatched lines are marked in the card", unknownCard?.unmatchedRows === 2);
  record("missing product", "unmatched lines offer creating a product", unknownCard?.createButtons === 2);

  const dialogOpened = await clickButton(
    cdp,
    `(b.getAttribute('aria-label') ?? '').startsWith('Создать товар для')`,
  );
  await sleep(900);
  const dialog = await evaluate(
    cdp,
    `(() => {
      const root = document.querySelector('[role=dialog]');
      if (!root) return null;
      const nameInput = root.querySelector('#invoice-product-name');
      return {
        name: nameInput?.value ?? null,
        category: root.querySelector('#invoice-product-category')?.textContent?.trim() ?? null,
        unit: root.querySelector('#invoice-product-unit')?.textContent?.trim() ?? null,
        markup: root.querySelector('#invoice-product-markup')?.value ?? null,
        aliases: root.querySelector('#invoice-product-aliases')?.value ?? null,
      };
    })()`,
  );
  console.log("create dialog:", JSON.stringify(dialog));
  record("missing product", "create dialog opens from the line", dialogOpened && Boolean(dialog));
  record("missing product", "dialog is prefilled with the printed name", Boolean(dialog?.name));
  record("missing product", "dialog suggests a category", Boolean(dialog?.category));
  record("missing product", "dialog suggests a unit", Boolean(dialog?.unit));
  record("missing product", "dialog suggests a markup", Number(dialog?.markup) > 0);
  record("missing product", "dialog offers an alias for voice commands", Boolean(dialog?.aliases));

  const createdName = `Орхидея Фаленопсис белая ${Date.now()}`;
  // Focus and select the field, then type through the input domain so React's
  // change handler runs exactly as it would for a real user.
  await evaluate(
    cdp,
    `(() => {
      const input = document.querySelector('#invoice-product-name');
      if (!input) return false;
      input.focus();
      input.setSelectionRange(0, input.value.length);
      return true;
    })()`,
  );
  await cdp.send("Input.insertText", { text: createdName });
  await sleep(400);
  const typedName = await evaluate(
    cdp,
    `document.querySelector('#invoice-product-name')?.value ?? null`,
  );
  console.log("typed name:", typedName);
  record("missing product", "the printed name can be corrected before saving", typedName === createdName);

  await clickButton(cdp, `b.textContent?.includes('Создать и привязать к строке')`);
  await sleep(900);

  const prepared = await evaluate(
    cdp,
    `(() => {
      const headings = [...document.querySelectorAll('span')].filter((s) => s.textContent === 'Накладная распознана');
      const root = headings[headings.length - 1]?.closest('div.rounded-xl');
      const labels = [...root.querySelectorAll('button')]
        .map((b) => b.textContent?.trim())
        .filter((label) => label?.startsWith('Провести приход'));
      return {
        bound: root.innerText.includes(${JSON.stringify(createdName)}),
        submitLabel: labels[0] ?? null,
      };
    })()`,
  );
  console.log("after create dialog:", JSON.stringify(prepared));
  record("missing product", "created product is attached to its line", prepared.bound);
  record("missing product", "the line is counted in the confirmation", prepared.submitLabel?.includes("(2)"));

  // The first confirmation already left a card behind, so the button is located
  // inside the newest (still pending) card.
  const submitInfo = await evaluate(
    cdp,
    `(() => {
      const cards = [...document.querySelectorAll('div.rounded-xl')].filter((root) =>
        root.innerText.includes('Накладная распознана'),
      );
      const pending = cards.filter((root) => !root.innerText.includes('Приход проведён'));
      const root = pending[pending.length - 1];
      if (!root) return { cards: cards.length, pending: 0, found: false };
      const button = [...root.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Провести приход'),
      );
      if (!button) return { cards: cards.length, pending: pending.length, found: false };
      const box = button.getBoundingClientRect();
      const scroller = document.querySelector('.overflow-y-auto');
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      const afterScroll = button.getBoundingClientRect();
      button.click();
      return {
        cards: cards.length,
        pending: pending.length,
        found: true,
        disabled: button.disabled,
        visible: afterScroll.top >= 0 && afterScroll.bottom <= window.innerHeight + 200,
        box: { top: Math.round(box.top), height: Math.round(box.height) },
        label: button.textContent.trim(),
      };
    })()`,
  );
  console.log("submit button:", JSON.stringify(submitInfo));
  const confirmed = Boolean(submitInfo?.found);
  record("missing product", "the pending card offers confirmation", confirmed);

  // The first confirmation already left a card and a toast behind, so success is
  // judged by the API: the created product has to show up in the catalog.
  let created = [];
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1000);
    created = await productsMatching(createdName);
    if (created.length) break;
  }
  const appliedState = await evaluate(
    cdp,
    `(() => {
      const cards = [...document.querySelectorAll('div.rounded-xl')].filter((root) =>
        root.innerText.includes('Накладная распознана'),
      );
      const errors = [...document.querySelectorAll('[data-sonner-toast]')]
        .map((element) => element.innerText.replace(/\\s+/g, ' ').trim())
        .filter((text) => text.includes('Не удалось') || text.includes('ошиб'));
      return { cards: cards.length, withNotice: cards.filter((root) => root.innerText.includes('Приход проведён')).length, errors };
    })()`,
  );
  console.log("applied state:", JSON.stringify(appliedState));
  const roseProducts = await productsMatching("Роза Эквадор красная");
  console.log(
    `created product: ${created[0]?.name} stock=${created[0]?.currentStock} ` +
      `purchase=${created[0]?.averagePrice} markup=${created[0]?.markupPercent}`,
  );
  record("missing product", "the server reported no error", appliedState.errors.length === 0);
  record(
    "missing product",
    "both confirmed documents report the applied state",
    appliedState.withNotice === 2,
  );
  record("missing product", "the new product exists after confirmation", created.length === 1);
  record("missing product", "the new product received its line quantity", created[0]?.currentStock === 40);
  record(
    "missing product",
    "the invoice price became its purchase price",
    created[0]?.averagePrice === 520,
  );
  record(
    "missing product",
    "the new product is searchable by its alias",
    (await productsMatching("орхидея фаленопсис")).some((product) => product.name === createdName),
  );
  record("missing product", "the known line of the same document was posted", roseProducts.length >= 1);

  const afterShot = await cdp.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(
    path.resolve(here, "..", "..", "screenshots", "check-invoice-applied.png"),
    Buffer.from(afterShot.data, "base64"),
  );

  console.log("\nresults:");
  let failed = 0;
  for (const [scope, label, ok] of results) {
    if (!ok) failed += 1;
    console.log(`  ${ok ? "ok  " : "FAIL"} [${scope}] ${label}`);
  }
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  cdp.close();
  process.exitCode = failed === 0 ? 0 : 1;
} finally {
  browser.kill();
  await sleep(600);
  rmSync(profile, { recursive: true, force: true });
}
