import { Router, type IRouter } from "express";
import { requireAuth } from "../middlewares/auth";
import healthRouter from "./health";
// Первый вход нового магазина: маршрут открыт без сессии, поэтому идёт до requireAuth.
import setupRouter from "./setup";
import authRouter from "./auth";
import usersRouter from "./users";
import channelsRouter from "./channels";
import botsRouter from "./bots";
import inventoryRouter from "./inventory";
import bouquetsRouter from "./bouquets";
import analyticsRouter from "./analytics";
import invoiceRouter from "./invoice";
import settingsRouter from "./settings";

const router: IRouter = Router();

router.use(healthRouter);
router.use(setupRouter);
// Auth runs before every other router: an Express router answers a matching
// route immediately, so mounting it after the auth routes would let those routes
// bypass the session check entirely.
router.use(requireAuth);
router.use(authRouter);
router.use(usersRouter);
router.use(channelsRouter);
router.use(botsRouter);
router.use(inventoryRouter);
router.use(bouquetsRouter);
router.use(analyticsRouter);
router.use(invoiceRouter);
router.use(settingsRouter);

export default router;
