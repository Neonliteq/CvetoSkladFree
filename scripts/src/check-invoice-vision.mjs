/**
 * Smoke test for invoice recognition: sends a fixture image to the configured
 * OpenAI-compatible provider and checks that it answers with exactly one
 * `read_invoice` tool call carrying the expected line items.
 *
 * Usage: node --env-file=.env scripts/src/check-invoice-vision.mjs [image]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const image = process.argv[2] ?? path.resolve(here, "..", "fixtures", "invoice-sample.png");

const baseUrl = process.env.OPENAI_BASE_URL ?? process.env.AI_INTEGRATIONS_OPENAI_BASE_URL;
const apiKey = process.env.OPENAI_API_KEY ?? process.env.AI_INTEGRATIONS_OPENAI_API_KEY;
const model = process.env.OPENAI_MODEL ?? "deepseek-flash";

if (!baseUrl || !apiKey) {
  throw new Error("OPENAI_BASE_URL and OPENAI_API_KEY must be set");
}

const extension = path.extname(image).toLowerCase();
const mime =
  extension === ".png" ? "image/png"
  : extension === ".webp" ? "image/webp"
  : extension === ".gif" ? "image/gif"
  : "image/jpeg";
const base64 = readFileSync(image).toString("base64");
console.log(`image: ${path.basename(image)} (${mime}, ${Math.round(base64.length / 1024)} KiB base64)`);

const system = `Ты распознаёшь товарные накладные цветочного магазина.
Верни ровно один вызов инструмента read_invoice со всеми позициями документа.
Читай название, количество, единицу измерения и цену за единицу строго из документа.
Названия переноси как написано в документе, без сокращений и без добавления артикулов.
Если поле не читается, верни null и отметь это в unclearFields.`;

const started = Date.now();
const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    max_tokens: 2000,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: "Разбери эту накладную и верни позиции." },
          { type: "image_url", image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read_invoice",
          description: "Вернуть распознанные позиции накладной",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["supplierName", "invoiceNumber", "invoiceDate", "items"],
            properties: {
              supplierName: { type: ["string", "null"] },
              invoiceNumber: { type: ["string", "null"] },
              invoiceDate: { type: ["string", "null"], description: "YYYY-MM-DD" },
              items: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["rawName", "quantity", "unitPrice"],
                  properties: {
                    rawName: { type: "string" },
                    quantity: { type: "number" },
                    unit: { type: ["string", "null"] },
                    unitPrice: { type: "number" },
                  },
                },
              },
              unclearFields: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    ],
    extra_body: { thinking: { type: "disabled" } },
  }),
});

if (!response.ok) {
  console.error(`HTTP ${response.status}:`, (await response.text()).slice(0, 800));
  process.exit(1);
}

const body = await response.json();
const message = body.choices?.[0]?.message;
console.log(`latency: ${Date.now() - started} ms, tokens: ${JSON.stringify(body.usage ?? {})}`);
console.log("finish_reason:", body.choices?.[0]?.finish_reason);
console.log("tool_calls:", message?.tool_calls?.length ?? 0);
if (message?.content) console.log("content:", message.content.slice(0, 200));

const call = message?.tool_calls?.[0];
if (!call) {
  console.error("FAIL: the model did not call read_invoice");
  process.exit(1);
}

const parsed = JSON.parse(call.function.arguments);
console.log("\nrecognised document:");
console.log(
  `  supplier=${parsed.supplierName} number=${parsed.invoiceNumber} date=${parsed.invoiceDate}`,
);
console.log(`  items: ${parsed.items.length}`);
for (const item of parsed.items) {
  console.log(
    `   - ${item.rawName} | ${item.quantity} ${item.unit ?? "?"} × ${item.unitPrice}`,
  );
}
if (parsed.unclearFields?.length) console.log("  unclear:", parsed.unclearFields.join(", "));

const expected = [
  ["Роза Эквадор красная", 300, 92],
  ["Роза Кения белая", 200, 85.5],
  ["Хризантема белая", 150, 61],
  ["Эустома розовая", 100, 73.5],
  ["Лента атласная пудровая", 100, 12.5],
  ["Бумага крафт для букета", 10, 455],
  ["Коробка подарочная средняя", 25, 205],
  ["Гипсофила белая", 20, 305],
];

const normalise = (value) =>
  String(value).toLocaleLowerCase("ru").replaceAll("ё", "е").replace(/[^a-zа-я0-9]+/giu, " ").trim();

let matched = 0;
for (const [name, quantity, price] of expected) {
  const hit = parsed.items.find(
    (item) =>
      normalise(item.rawName).includes(normalise(name).split(" ").slice(0, 2).join(" ")) &&
      item.quantity === quantity,
  );
  const priceOk = hit && Math.abs(hit.unitPrice - price) < 0.01;
  if (hit && priceOk) matched += 1;
  console.log(
    `${hit && priceOk ? "  ok  " : "  MISS"} ${name} ${quantity} × ${price}` +
      (hit ? ` → got "${hit.rawName}" ${hit.quantity} × ${hit.unitPrice}` : " → not found"),
  );
}
console.log(`\nmatched ${matched}/${expected.length}`);
process.exit(matched === expected.length ? 0 : 2);
