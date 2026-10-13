/**
 * End-to-end check of the invoice photo flow against a running API server:
 * recognise the fixture photo, verify the draft, confirm it, then verify that
 * stock, batches and the assistant conversation all moved.
 *
 * Usage: node scripts/src/check-invoice-e2e.mjs [imagePath] [baseUrl]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn } from "./auth-helper.mjs";

// Posting invoices changes stock, so the check starts from the known assortment.
seedDatabase();

const here = path.dirname(fileURLToPath(import.meta.url));
const image = process.argv[2] ?? path.resolve(here, "..", "fixtures", "invoice-sample.png");
const base = (process.argv[3] ?? "http://127.0.0.1:5000").replace(/\/+$/, "");
const conversationId = `invoice-e2e-${Date.now()}`;

// Every endpoint is behind a session now.
const session = await signIn(base);
console.log("signed in:", session.cookies.map((cookie) => cookie.name).join(", "));

const extension = path.extname(image).toLowerCase();
const mime = extension === ".png" ? "image/png" : extension === ".webp" ? "image/webp" : "image/jpeg";
const imageDataUrl = `data:${mime};base64,${readFileSync(image).toString("base64")}`;

async function api(method, url, body) {
  const response = await fetch(`${base}${url}`, {
    method,
    headers: {
      cookie: session.cookieHeader,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    throw new Error(`${method} ${url} → ${response.status}: ${JSON.stringify(parsed).slice(0, 400)}`);
  }
  return parsed;
}

const stockOf = async (name) => {
  const products = await api("GET", `/api/products?search=${encodeURIComponent(name)}`);
  const product = products.find((item) => item.name === name);
  if (!product) throw new Error(`product not found: ${name}`);
  return product;
};

const steps = [];
console.log(`conversation: ${conversationId}`);

// ---------------------------------------------------------------- recognition
const before = await stockOf("Роза Эквадор красная");
const recognitionStarted = Date.now();
const draft = await api("POST", "/api/assistant/invoice/recognize", {
  conversationId,
  imageDataUrl,
});
console.log(`recognise: ${Date.now() - recognitionStarted} ms`);
console.log(
  `document: supplier=${draft.supplierName} number=${draft.invoiceNumber} date=${draft.invoiceDate}`,
);
console.log(`items: ${draft.recognized}, ready for posting: ${draft.catalogLines}`);
for (const item of draft.items) {
  console.log(
    `  [${item.matchStatus}] ${item.rawName} — ${item.quantity} × ${item.unitPrice} ₽` +
      (item.productName ? ` → ${item.productName}` : "") +
      (item.issues?.length ? ` (${item.issues.join("; ")})` : ""),
  );
}
steps.push(["recognition returned every line", draft.items.length === 8]);
steps.push([
  "recognition matched the whole catalog",
  draft.items.every((item) => item.matchStatus === "matched"),
]);
steps.push([
  "recognition found the document header",
  draft.supplierName?.includes("ЦветТорг") && draft.invoiceNumber === "4712",
]);

// ------------------------------------------------------------------ draft card
const conversation = await api("GET", `/api/assistant/conversations/${conversationId}`);
const draftMessage = conversation.messages.find((message) => message.invoiceDraft);
steps.push(["draft is stored in the conversation", Boolean(draftMessage)]);
steps.push([
  "draft is marked as pending review",
  draftMessage?.invoiceReview?.status === "pending",
]);
steps.push([
  "document header survives the round trip",
  draftMessage?.invoiceDraft?.invoiceNumber === draft.invoiceNumber,
]);

// -------------------------------------------------------------------- confirm
const lines = draft.items.map((item) => ({
  productId: item.productId,
  rawName: item.rawName,
  quantity: item.quantity,
  unitPrice: item.unitPrice,
}));
const applied = await api("POST", "/api/assistant/invoice/apply", {
  conversationId,
  supplierName: draft.supplierName,
  invoiceNumber: draft.invoiceNumber,
  invoiceDate: draft.invoiceDate,
  items: lines,
});
console.log(`apply: ${applied.answer}`);
console.log(`operation ids: ${applied.operationIds.join(", ")}`);

steps.push(["apply created one movement per line", applied.operationIds.length === 8]);
steps.push(["apply reported the invoice total", applied.totalCost === 78225]);
steps.push(["apply reported the invoice quantity", applied.quantity === 905]);
steps.push([
  "a batch of lines cannot be undone as one click",
  applied.canUndo === false,
]);

// ----------------------------------------------------------------- effect on stock
const after = await stockOf("Роза Эквадор красная");
console.log(`rose stock: ${before.currentStock} → ${after.currentStock} (expected +300)`);
steps.push(["stock grew by the delivered quantity", after.currentStock === before.currentStock + 300]);
steps.push([
  "average price moved towards the invoice price",
  after.averagePrice < before.averagePrice && after.averagePrice > 92,
]);

const movements = await api("GET", "/api/movements?limit=20");
const invoiceMovements = movements.filter((movement) =>
  applied.operationIds.includes(movement.id),
);
steps.push(["each posted line is a receipt movement", invoiceMovements.length === 8]);
steps.push([
  "movements carry the invoice number",
  invoiceMovements.every((movement) => movement.orderNumber === "4712"),
]);
steps.push([
  "movements carry the document date as the arrival date",
  invoiceMovements.every((movement) => String(movement.batchArrivalDate).startsWith("2026-09-09")),
]);
steps.push([
  "new batches hold their full quantity",
  invoiceMovements.every((movement) => movement.remainingQuantity === movement.quantity),
]);

const dashboard = await api("GET", "/api/dashboard");
steps.push(["dashboard still answers", typeof dashboard.totalProducts === "number"]);

// ------------------------------------------------- creating a missing product
// A second conversation posts one line for a product the catalog does not have,
// exactly as the assistant offers after "товар не найден в каталоге".
const newProductConversation = `${conversationId}-new`;
const unknownDraft = await api("POST", "/api/assistant/invoice/recognize", {
  conversationId: newProductConversation,
  imageDataUrl,
});
const unknownLine = unknownDraft.items[0];
const createdName = `Тестовый товар ${Date.now()}`;
const created = await api("POST", "/api/assistant/invoice/apply", {
  conversationId: newProductConversation,
  supplierName: unknownDraft.supplierName,
  invoiceNumber: unknownDraft.invoiceNumber,
  invoiceDate: unknownDraft.invoiceDate,
  items: [
    {
      productId: null,
      rawName: unknownLine.rawName,
      quantity: 7,
      unitPrice: 123.45,
      newProduct: {
        name: createdName,
        aliases: ["тестовый псевдоним"],
        category: unknownLine.suggestedCategory ?? "Цветы",
        unit: unknownLine.suggestedUnit ?? "шт",
        minimumStock: 0,
        markupPercent: unknownLine.suggestedMarkupPercent ?? 100,
        shelfLifeDays: unknownLine.suggestedShelfLifeDays ?? 0,
      },
    },
  ],
});
console.log(`create+receive: ${created.answer}`);
steps.push(["a missing product was created with the invoice", created.createdProductIds?.length === 1]);
const createdProduct = await stockOf(createdName);
steps.push(["the new product exists in the catalog", createdProduct.id === created.createdProductIds[0]]);
steps.push(["the new product received the delivered quantity", createdProduct.currentStock === 7]);
steps.push(["the invoice price became the purchase price", createdProduct.averagePrice === 123.45]);
steps.push([
  "the markup suggestion was applied",
  createdProduct.markupPercent === (unknownLine.suggestedMarkupPercent ?? 100),
]);
steps.push([
  "the new product is searchable by its alias",
  (await api("GET", `/api/products?search=${encodeURIComponent("тестовый псевдоним")}`)).some(
    (product) => product.id === createdProduct.id,
  ),
]);

const badRequest = await fetch(`${base}/api/assistant/invoice/apply`, {
  method: "POST",
  headers: { "Content-Type": "application/json", cookie: session.cookieHeader },
  body: JSON.stringify({
    conversationId: newProductConversation,
    items: [{ productId: null, rawName: "Строка без товара", quantity: 1, unitPrice: 1 }],
  }),
});
steps.push([
  "a line with neither product nor new product is rejected",
  badRequest.status === 400,
]);

// ------------------------------------------------------------------- undo a line
const conversationAfter = await api("GET", `/api/assistant/conversations/${conversationId}`);
const appliedCard = conversationAfter.messages.find((message) => message.invoiceDraft);
steps.push([
  "draft card is marked as applied after confirmation",
  appliedCard?.invoiceReview?.status === "applied" &&
    appliedCard?.invoiceReview?.appliedCount === 8,
]);

const undoableLine = conversationAfter.messages.find(
  (message) => message.action === "invoice_receipt_created" && message.canUndo,
);
steps.push(["at least one posted line stays revertible", Boolean(undoableLine)]);
if (undoableLine?.operationId) {
  const undoneMovement = invoiceMovements.find(
    (movement) => movement.id === undoableLine.operationId,
  );
  const productBefore = await stockOf(undoneMovement.productName);
  const undone = await api(
    "POST",
    `/api/assistant/operations/${undoableLine.operationId}/undo`,
    { conversationId },
  );
  console.log(`undo: ${undone.answer}`);
  const productAfter = await stockOf(undoneMovement.productName);
  console.log(
    `${undoneMovement.productName}: ${productBefore.currentStock} → ${productAfter.currentStock}`,
  );
  steps.push([
    "undoing a line rolls its quantity back",
    productAfter.currentStock === productBefore.currentStock - undoneMovement.quantity,
  ]);
}

console.log("\nresults:");
let failed = 0;
for (const [label, ok] of steps) {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label}`);
}
console.log(`\n${steps.length - failed}/${steps.length} checks passed`);
process.exit(failed === 0 ? 0 : 1);
