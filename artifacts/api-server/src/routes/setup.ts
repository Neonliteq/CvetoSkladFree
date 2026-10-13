/**
 * Первый вход нового магазина: проверка ссылки и создание администратора.
 *
 * Маршруты открыты без сессии — иначе владелец магазина не смог бы войти впервые.
 * Поэтому здесь нет ничего, кроме этих двух действий: никаких списков, настроек или
 * данных склада. Ссылка одноразовая и живёт сутки, а пароль задаёт сам владелец
 * магазина, так что пересылать пароли никому не нужно.
 */
import { Router, type IRouter } from "express";
import { CompleteSetupBody, InspectSetupLinkResponse, CompleteSetupResponse } from "@workspace/api-zod";
import { inspectSetupToken, redeemSetupToken } from "../lib/shop-setup";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get("/setup/:token", async (req, res): Promise<void> => {
  const state = await inspectSetupToken(req.params.token);
  res.json(InspectSetupLinkResponse.parse(state));
});

router.post("/setup", async (req, res): Promise<void> => {
  const parsed = CompleteSetupBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте логин и пароль: логин от трёх символов, пароль от восьми" });
    return;
  }

  const state = await inspectSetupToken(parsed.data.token);
  if (state.status !== "valid") {
    res.status(400).json({
      error:
        state.status === "used"
          ? "Ссылка уже использована. Попросите новую."
          : state.status === "expired"
            ? "Срок действия ссылки истёк. Попросите новую."
            : "Ссылка не найдена. Проверьте адрес.",
    });
    return;
  }

  const result = await redeemSetupToken({
    token: parsed.data.token,
    username: parsed.data.username,
    displayName: parsed.data.displayName ?? "",
    password: parsed.data.password,
  });
  if (!result.ok) {
    res.status(400).json({ error: result.reason });
    return;
  }

  logger.info({ username: result.username, shop: state.shopName }, "Магазин завершил первый вход");
  res.status(201).json(CompleteSetupResponse.parse({ username: result.username, shopName: state.shopName }));
});

export default router;
