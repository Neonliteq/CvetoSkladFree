/**
 * Прогоняет набор реальных команд через ассистента и собирает результаты.
 *
 * Ничего не записывает в учёт: команды, требующие проведения, отклоняются —
 * разбор и уточнения видны в ответе.
 *
 * Usage: node scripts/src/probe-assistant.mjs [api-base]
 */
const api = process.argv[2] ?? process.env.API_BASE ?? "http://127.0.0.1:5000";

const login = await fetch(`${api}/api/auth/login`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    origin: new URL(api).origin,
  },
  body: JSON.stringify({
    username: process.env.AUTH_ROOT_USERNAME ?? "admin",
    password: process.env.AUTH_ROOT_PASSWORD,
  }),
});
if (!login.ok) {
  console.error("Не удалось войти:", login.status, await login.text());
  process.exit(2);
}
const cookie = (login.headers.getSetCookie?.() ?? []).map((e) => e.split(";")[0]).join("; ");

/** Команды, с которыми работает магазин. Ни одна не должна менять склад. */
const commands = [
  "Покажи остатки",
  "Сколько роз осталось",
  "Что заканчивается",
  "Продажа 1 роза",
  "Продали 5 хризантем",
  "Спиши 3 увядшие розы",
  "Приход 20 роз по 100",
  "Сколько стоит букет весенний",
  "Какие поставки скоро испортятся",
  "Измени наценку на розы на 150%",
];

const ask = async (message) => {
  const response = await fetch(`${api}/api/assistant/command`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ conversationId: `probe-${Date.now()}-${Math.random()}`, message }),
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body };
};

let understood = 0;
let doubtful = 0;
let failed = 0;

for (const message of commands) {
  const started = Date.now();
  const { status, body } = await ask(message);
  const ms = Date.now() - started;

  const action = body?.action ?? "—";
  const plan = body?.plan;
  const operations = plan?.operations?.length ?? 0;
  const clarifications = plan?.clarifications?.length ?? 0;
  const answer = String(body?.answer ?? body?.error ?? "").replace(/\s+/gu, " ").slice(0, 150);

  let verdict = "не понял";
  if (status !== 200) {
    verdict = "ошибка";
    failed += 1;
  } else if (operations > 0) {
    verdict = `понял: операций ${operations}`;
    understood += 1;
  } else if (clarifications > 0) {
    verdict = `уточняет: позиций ${clarifications}`;
    doubtful += 1;
  } else if (action === "answered") {
    verdict = "ответ текстом";
    understood += 1;
  } else {
    failed += 1;
  }

  console.log(`\n[${verdict}] ${message}`);
  console.log(`  статус ${status}, ${ms} мс, action=${action}`);
  if (operations || clarifications) {
    console.log(`  операций ${operations}, уточнений ${clarifications}`);
  }
  console.log(`  ответ: ${answer}`);
  const errors = body?.errors ?? body?.plan?.clarifications?.map((c) => c.message).filter(Boolean);
  if (errors?.length) console.log(`  ошибки: ${JSON.stringify(errors).slice(0, 200)}`);
}

console.log("\n================ ИТОГО ================");
console.log(`понял:      ${understood} из ${commands.length}`);
console.log(`уточняет:   ${doubtful}`);
console.log(`не осилил:  ${failed}`);
