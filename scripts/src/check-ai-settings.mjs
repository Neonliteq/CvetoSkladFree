/**
 * Проверяет настройки AI-провайдера в интерфейсе администратора.
 *
 * Главное здесь — доказать, что сохранённые настройки действительно действуют:
 * скрипт поднимает свой мини-сервер, совместимый с OpenAI API, направляет
 * ассистента на него и проверяет, что запрос пришёл именно туда и именно с
 * сохранённой моделью. Никакого настоящего ключа для этого не нужно.
 *
 * Usage: node scripts/src/check-ai-settings.mjs
 */
import { createServer } from "node:http";
import { seedDatabase } from "./seed-helper.mjs";
import { signIn } from "./auth-helper.mjs";

const api = process.env.API_BASE ?? "http://127.0.0.1:5000";
const stubPort = Number(process.env.STUB_PORT ?? 5199);
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
    headers: {
      cookie: session.cookieHeader,
      origin: new URL(api).origin,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text.slice(0, 200);
  }
  return { status: response.status, body: parsed };
};

// Заглушка должна назвать товар так же, как это делает модель: с настоящим id и
// названием из каталога, иначе проверка отбора товара отклонит операцию.
const target = (await call("GET", "/api/products?search=эвкалипт")).body?.[0];
if (!target) throw new Error("В демо-данных нет эвкалипта");
const targetStockBefore = target.currentStock;
console.log(`  товар для проверки: ${target.name} (id ${target.id}), остаток ${targetStockBefore}`);

// ---------------------------------------------------------------- заглушка API
const received = [];
let stubMode = "tool_call";
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
    received.push({ url: req.url, authorization: req.headers.authorization, payload });

    if (stubMode === "unauthorized") {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Incorrect API key provided", type: "invalid_request_error" } }));
      return;
    }
    // Заглушка отвечает как провайдер с поддержкой инструментов: сначала вызов
    // операции, а на повторный запрос с результатами — обычный текст.
    const hasToolResult = JSON.stringify(payload?.messages ?? []).includes('"role":"tool"');
    const wantsTools = Array.isArray(payload?.tools) && payload.tools.length > 0;
    if (wantsTools && !hasToolResult && stubMode === "tool_call") {
      // Заглушка отвечает вызовом операции: склад должен измениться, иначе
      // непонятно, действительно ли ассистент пошёл через сохранённый адрес.
      const saleTool = payload.tools
        .map((tool) => tool.function?.name)
        .find((name) => typeof name === "string" && name === "create_outflow");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "stub-1",
          object: "chat.completion",
          model: payload.model,
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_1",
                    type: "function",
                    function: {
                      name: saleTool ?? "create_outflow",
                      arguments: JSON.stringify({
                        productId: target.id,
                        productName: target.name,
                        quantity: 1,
                        operationType: "expense",
                        reason: "Проверка настроек AI",
                      }),
                    },
                  },
                ],
              },
            },
          ],
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "stub-2",
        object: "chat.completion",
        model: payload?.model ?? "stub",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content: "Заглушка ответила" } },
        ],
      }),
    );
  });
});
await new Promise((resolve) => stub.listen(stubPort, "127.0.0.1", resolve));
const stubUrl = `http://127.0.0.1:${stubPort}/v1`;

try {
  console.log("=== 1. Настройки закрыты для сотрудника и открыты администратору ===");
  const settings = await call("GET", "/api/settings/ai");
  record("администратор читает настройки", settings.status === 200, `статус ${settings.status}`);
  record(
    "в ответе нет самого ключа",
    !JSON.stringify(settings.body ?? {}).toLowerCase().includes('"apikey"'),
    JSON.stringify(settings.body)?.slice(0, 200),
  );
  record(
    "видно, чей провайдер действует",
    ["shop", "platform", "none"].includes(settings.body?.source),
    JSON.stringify({ source: settings.body?.source, platformConfigured: settings.body?.platformConfigured }),
  );
  record(
    "платформенный ключ не отдаётся даже окончанием",
    settings.body?.platformKeySet === true
      ? settings.body?.source !== "platform" || !String(settings.body?.keySuffix ?? "").length
      : true,
    JSON.stringify({ source: settings.body?.source, keySuffix: settings.body?.keySuffix }),
  );

  // Сотрудник: создаём его тем же путём, что и в жизни — через админский API.
  const suffix = Date.now();
  const staffName = `staff${suffix}`;
  const created = await call("POST", "/api/users", {
    username: staffName,
    displayName: "Проверка настроек",
    password: "staff-password-123",
    role: "staff",
  });
  record("сотрудник создан", created.status === 201, `статус ${created.status}`);
  const staffSession = await signIn(api, staffName, "staff-password-123");
  const staffPut = await fetch(`${api}/api/settings/ai`, {
    method: "PUT",
    headers: {
      cookie: staffSession.cookieHeader,
      origin: new URL(api).origin,
      "content-type": "application/json",
    },
    body: JSON.stringify({ provider: "shop", baseUrl: "https://example.com/v1", model: "x", apiKey: "x" }),
  });
  record(
    "сотруднику менять настройки нельзя",
    staffPut.status === 403 || staffPut.status === 401,
    `статус ${staffPut.status}`,
  );
  await call("PATCH", `/api/users/${created.body?.id}`, { isActive: false });

  console.log("\n=== 2. Свой провайдер магазина ===");
  const badUrl = await call("PUT", "/api/settings/ai", {
    provider: "shop",
    baseUrl: "не ссылка",
    model: "stub-model",
    apiKey: "key",
  });
  record("адрес без схемы отклонён", badUrl.status === 400, `статус ${badUrl.status}: ${JSON.stringify(badUrl.body)?.slice(0, 100)}`);
  const noKey = await call("PUT", "/api/settings/ai", {
    provider: "shop",
    baseUrl: "https://example.com/v1",
    model: "stub-model",
  });
  record(
    "свой провайдер без ключа отклонён",
    noKey.status === 400,
    `статус ${noKey.status}: ${JSON.stringify(noKey.body)?.slice(0, 100)}`,
  );
  const saved = await call("PUT", "/api/settings/ai", {
    provider: "shop",
    baseUrl: stubUrl,
    apiKey: "stub-secret-key-1234",
    model: "stub-model",
  });
  record("свой провайдер сохранён", saved.status === 200, `статус ${saved.status}: ${JSON.stringify(saved.body)?.slice(0, 150)}`);
  record(
    "действует ключ магазина, а не платформы",
    saved.body?.source === "shop" && saved.body?.shopKeySet === true,
    JSON.stringify({ source: saved.body?.source, shopKeySet: saved.body?.shopKeySet }),
  );
  record(
    "ключ магазина показан только последними символами",
    typeof saved.body?.keySuffix === "string" && saved.body.keySuffix.endsWith("1234"),
    String(saved.body?.keySuffix),
  );
  record(
    "действующая модель — сохранённая",
    saved.body?.modelInUse === "stub-model",
    String(saved.body?.modelInUse),
  );

  console.log("\n=== 3. Проверка связи ===");
  const checked = await call("POST", "/api/settings/ai/test", {});
  console.log("  ответ проверки:", JSON.stringify(checked.body));
  record("проверка связи прошла", checked.body?.ok === true, JSON.stringify(checked.body)?.slice(0, 200));
  record(
    "запрос ушёл на сохранённый адрес и с сохранённой моделью",
    received.some(
      (entry) => entry.url?.includes("/chat/completions") && entry.payload?.model === "stub-model",
    ),
    JSON.stringify(received.map((entry) => ({ url: entry.url, model: entry.payload?.model }))),
  );
  record(
    "ключ передан в заголовке авторизации",
    received.some((entry) => String(entry.authorization ?? "").includes("stub-secret-key-1234")),
    String(received[0]?.authorization),
  );

  console.log("\n=== 4. Ассистент работает через сохранённый провайдер ===");
  received.length = 0;
  const command = await call("POST", "/api/assistant/command", {
    conversationId: `settings-check-${suffix}`,
    message: `продали 1 ${target.name.toLowerCase()}`,
  });
  console.log("  ответ ассистента:", JSON.stringify(command.body)?.slice(0, 200));
  record(
    "ассистент обратился к сохранённому провайдеру",
    received.some((entry) => entry.url?.includes("/chat/completions")),
    JSON.stringify(received.map((entry) => entry.url)),
  );
  record(
    "ассистент использовал сохранённую модель",
    received.length > 0 && received.every((entry) => entry.payload?.model === "stub-model"),
    JSON.stringify(received.map((entry) => entry.payload?.model)),
  );
  const afterStock = (await call("GET", "/api/products?search=эвкалипт")).body?.[0]?.currentStock;
  record(
    "операция из ответа заглушки проведена на складе",
    afterStock === targetStockBefore - 1,
    `${targetStockBefore} → ${afterStock}, ответ ${JSON.stringify(command.body)?.slice(0, 200)}`,
  );

  console.log("\n=== 5. Неверный ключ виден в проверке связи ===");
  stubMode = "unauthorized";
  const broken = await call("POST", "/api/settings/ai/test", {});
  console.log("  ответ проверки:", JSON.stringify(broken.body));
  record(
    "проверка сообщает об отказе провайдера",
    broken.body?.ok === false && /401|Incorrect API key|отклонил/u.test(String(broken.body?.answer)),
    JSON.stringify(broken.body)?.slice(0, 200),
  );
  record(
    "настройки при этом не сброшены",
    (await call("GET", "/api/settings/ai")).body?.source === "shop",
    JSON.stringify((await call("GET", "/api/settings/ai")).body?.source),
  );
  stubMode = "tool_call";

  console.log("\n=== 6. Возврат к общему провайдеру сервиса ===");
  // Выключаем свой провайдер и убеждаемся, что система возвращается к общему, а
  // не падает: именно так выглядит откат, если свой ключ оказался нерабочим.
  const cleared = await call("PUT", "/api/settings/ai", { provider: "platform" });
  record(
    "свой ключ убран",
    cleared.body?.shopKeySet === false && cleared.body?.apiKeySet === false,
    JSON.stringify({ shopKeySet: cleared.body?.shopKeySet, apiKeySet: cleared.body?.apiKeySet }),
  );
  record(
    "свои адрес и модель очищены",
    cleared.body?.shopBaseUrl === null && cleared.body?.shopModel === null,
    JSON.stringify({ baseUrl: cleared.body?.shopBaseUrl, model: cleared.body?.shopModel }),
  );
  record(
    "вернулся общий провайдер сервиса",
    cleared.body?.source === (cleared.body?.platformConfigured ? "platform" : "none"),
    JSON.stringify({ source: cleared.body?.source, platformConfigured: cleared.body?.platformConfigured }),
  );

  console.log("\n=== 6б. Ассистент идёт к общему провайдеру сервиса ===");
  // Если проверку запустили с PLATFORM_STUB=1, адрес платформы указывает на нашу
  // заглушку — тогда видно, что запрос ушёл именно к общему провайдеру, а не к
  // ключу магазина. Без этого флага проверяем только ответ API.
  if (process.env.PLATFORM_STUB === "1") {
    received.length = 0;
    const platformAnswer = await call("POST", "/api/assistant/command", {
      conversationId: `platform-check-${suffix}`,
      message: `продали 1 ${target.name.toLowerCase()}`,
    });
    record(
      "ассистент обратился к общему провайдеру",
      received.length > 0 && received.every((entry) => entry.url?.includes("/chat/completions")),
      JSON.stringify(received.map((entry) => entry.url)),
    );
    record(
      "запрос ушёл с моделью платформы, а не магазина",
      received.length > 0 && received.every((entry) => entry.payload?.model !== "stub-model"),
      JSON.stringify(received.map((entry) => entry.payload?.model)),
    );
    record(
      "ассистент ответил на команду",
      typeof platformAnswer.body?.answer === "string" && platformAnswer.body.answer.length > 0,
      JSON.stringify(platformAnswer.body)?.slice(0, 200),
    );
    // Ключ платформы не должен утечь ни одним полем: проверяем весь ответ
    // целиком, а не только поле с окончанием ключа.
    const platformSecret = process.env.OPENAI_API_KEY ?? "";
    const platformPayload = JSON.stringify(await call("GET", "/api/settings/ai"));
    record(
      "ключ платформы не появляется в ответах ни в каком виде",
      !platformSecret ||
        (!platformPayload.includes(platformSecret) && !/••••9999/.test(platformPayload)),
      platformPayload.slice(0, 250),
    );
  } else {
    record(
      "проверка платформенного пути пропущена (нет PLATFORM_STUB=1)",
      true,
      "",
    );
  }

  console.log("\n=== 7. Настройки не текут в ответах для сотрудника ===");
  const staffRead = await fetch(`${api}/api/settings/ai`, {
    headers: { cookie: staffSession.cookieHeader, origin: new URL(api).origin },
  });
  record(
    "сотрудник не читает настройки",
    staffRead.status === 403 || staffRead.status === 401,
    `статус ${staffRead.status}`,
  );
} finally {
  stub.close();
}

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\n${results.length - failed}/${results.length} проверок пройдено`);
process.exit(failed === 0 ? 0 : 1);
