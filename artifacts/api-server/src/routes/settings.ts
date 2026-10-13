/**
 * Настройки AI-провайдера: чтение, запись и проверка связи.
 *
 * Только для администратора: здесь лежит ключ API, которым пользуется ассистент
 * и распознавание накладных. Ключ наружу не отдаётся — интерфейс видит лишь
 * «задан» и последние символы, поэтому подсмотреть его через API нельзя.
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { aiSettingsTable, db, usersTable } from "@workspace/db";
import {
  GetAiSettingsResponse,
  TestAiConnectionResponse,
  UpdateAiSettingsBody,
  UpdateAiSettingsResponse,
} from "@workspace/api-zod";
import { requireRole } from "../middlewares/auth";
import {
  aiProviderFromEnvironment,
  invalidateAiProviderCache,
  keySuffix,
  resolveAiProvider,
  testAiConnection,
} from "../lib/ai-config";

const router: IRouter = Router();

/** Настройки из базы: строка ровно одна. */
async function loadRow() {
  const [row] = await db.select().from(aiSettingsTable).where(eq(aiSettingsTable.id, 1));
  return row ?? null;
}

/**
 * Отдаёт действующее состояние.
 *
 * Магазин видит двух разных провайдеров и должен понимать, какой работает:
 * **платформенный** (его задаёт владелец сервиса, магазину он недоступен) и
 * **свой** (ключ магазина, который владелец вводит сам). Ключ платформы наружу
 * не отдаётся ни в каком виде — только факт «задан».
 */
async function describeSettings() {
  const row = await loadRow();
  const env = aiProviderFromEnvironment();
  const active = await resolveAiProvider();
  const platformConfigured = Boolean(env.apiKey && env.baseUrl);
  let updatedByName: string | null = null;
  if (row?.updatedBy) {
    const [author] = await db
      .select({ displayName: usersTable.displayName })
      .from(usersTable)
      .where(eq(usersTable.id, row.updatedBy));
    updatedByName = author?.displayName ?? null;
  }
  return {
    source: active?.source ?? "none",
    shopBaseUrl: row?.baseUrl ?? null,
    shopModel: row?.model ?? null,
    shopKeySet: Boolean(row?.apiKey),
    platformConfigured,
    platformModel: platformConfigured ? env.model : null,
    platformBaseUrl: platformConfigured ? env.baseUrl : null,
    platformKeySet: Boolean(env.apiKey),
    modelInUse: active?.model ?? null,
    apiKeySet: Boolean(row?.apiKey),
    keySuffix: keySuffix(row?.apiKey),
    updatedAt: row?.updatedAt ? row.updatedAt.toISOString() : null,
    updatedByName,
  };
}

router.get("/settings/ai", requireRole("admin"), async (_req, res): Promise<void> => {
  res.json(GetAiSettingsResponse.parse(await describeSettings()));
});

router.put("/settings/ai", requireRole("admin"), async (req, res): Promise<void> => {
  const parsed = UpdateAiSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const existing = await loadRow();

  // Возврат к общему провайдеру сервиса: свои значения магазина убираем совсем,
  // чтобы не осталось «полунастроенного» состояния, которое мешало бы потом.
  if (parsed.data.provider === "platform") {
    await db.delete(aiSettingsTable).where(eq(aiSettingsTable.id, 1));
    invalidateAiProviderCache();
    res.json(UpdateAiSettingsResponse.parse(await describeSettings()));
    return;
  }

  // Свой провайдер магазина: адрес обязателен, иначе непонятно, куда обращаться.
  const rawBaseUrl = parsed.data.baseUrl?.trim() ?? "";
  if (!rawBaseUrl) {
    res.status(400).json({
      error: "Для своего провайдера укажите адрес API, например https://api.deepseek.com/v1",
    });
    return;
  }
  let baseUrl: string;
  try {
    const parsedUrl = new URL(rawBaseUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("protocol");
    }
    // Хвостовой слэш ломает склейку путей в SDK, поэтому убираем его сразу.
    baseUrl = rawBaseUrl.replace(/\/+$/u, "");
  } catch {
    res.status(400).json({
      error: "Адрес API должен быть полной ссылкой, например https://api.deepseek.com/v1",
    });
    return;
  }

  const model = parsed.data.model?.trim() || null;
  // Пустое поле ключа означает «оставить прежний»: владелец правит модель или
  // адрес, не вводя ключ заново.
  const apiKey = parsed.data.apiKey?.trim() || existing?.apiKey || null;
  if (!apiKey) {
    res.status(400).json({
      error: "Для своего провайдера укажите ключ API",
    });
    return;
  }

  await db
    .insert(aiSettingsTable)
    .values({ id: 1, baseUrl, model, apiKey, updatedBy: req.user?.id ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiSettingsTable.id,
      set: { baseUrl, model, apiKey, updatedBy: req.user?.id ?? null, updatedAt: new Date() },
    });
  invalidateAiProviderCache();

  res.json(UpdateAiSettingsResponse.parse(await describeSettings()));
});

router.post("/settings/ai/test", requireRole("admin"), async (_req, res): Promise<void> => {
  const result = await testAiConnection();
  res.json(TestAiConnectionResponse.parse(result));
});

export default router;
