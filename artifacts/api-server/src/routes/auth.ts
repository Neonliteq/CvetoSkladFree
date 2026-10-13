import { Router, type IRouter, type Request, type Response } from "express";
import { and, eq, gt, inArray, isNull } from "drizzle-orm";
import {
  devicePinsTable,
  devicesTable,
  db,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import {
  GetCurrentUserResponse,
  GetTrustedDeviceResponse,
  ListDeviceUsersResponse,
  LoginBody,
  LoginWithPinBody,
  TrustCurrentDeviceBody,
} from "@workspace/api-zod";
import {
  DEVICE_COOKIE,
  LoginThrottle,
  PIN_LOCK_MS,
  PIN_MAX_ATTEMPTS,
  PIN_SESSION_TTL_MS,
  SESSION_COOKIE,
  createToken,
  deviceExpiry,
  hashPassword,
  hashToken,
  normalizeUsername,
  sessionExpiry,
  verifyPassword,
} from "../lib/auth";
import { logger } from "../lib/logger";
import { clientIp, recordAuthEvent } from "./auth-events";
import { hasPendingSetupToken } from "../lib/shop-setup";

const router: IRouter = Router();

const throttle = new LoginThrottle();

const isProduction = () => process.env.NODE_ENV === "production";

/**
 * Session cookie.
 *
 * `httpOnly` keeps it away from scripts, `sameSite: lax` is enough because the
 * app has no cross-site flows, and `secure` is on in production — the deployment
 * is HTTPS, so the cookie must never travel in clear text.
 */
function setSessionCookie(res: Response, token: string, expiresAt: Date) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: expiresAt,
  });
}

function clearSessionCookie(res: Response) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
  });
}

/** Resolves the session cookie into a user, refreshing `last_seen_at`. */
export async function resolveSession(req: Request) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token !== "string" || !token) return null;

  const [row] = await db
    .select({
      session: sessionsTable,
      user: usersTable,
    })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(
      and(
        eq(sessionsTable.tokenHash, hashToken(token)),
        gt(sessionsTable.expiresAt, new Date()),
      ),
    );

  if (!row) return null;
  // A disabled account loses access immediately, even with a valid session.
  if (!row.user.isActive) return null;

  return { session: row.session, user: row.user, token };
}

router.get("/auth/me", async (req, res): Promise<void> => {
  const resolved = await resolveSession(req);
  if (!resolved) {
    res.status(401).json({ error: "Требуется вход" });
    return;
  }
  res.json(
    GetCurrentUserResponse.parse({
      user: {
        id: resolved.user.id,
        username: resolved.user.username,
        displayName: resolved.user.displayName,
        role: resolved.user.role,
      },
      expiresAt: resolved.session.expiresAt,
      viaDevice: resolved.session.deviceId !== null,
    }),
  );
});

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Укажите логин и пароль" });
    return;
  }

  const username = normalizeUsername(parsed.data.username);
  const throttleKey = `${username}|${clientIp(req) ?? "unknown"}`;
  const retryAfter = throttle.retryAfterMs(throttleKey);
  if (retryAfter > 0) {
    const minutes = Math.ceil(retryAfter / 60000);
    await recordAuthEvent({
      username,
      event: "login_blocked",
      req,
      detail: `retry after ${minutes} min`,
    });
    res.status(429).json({
      error: `Слишком много неудачных попыток. Повторите через ${minutes} мин.`,
    });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, username));

  // The same answer and roughly the same work for "no such user" and "wrong
  // password", so the response does not reveal which accounts exist.
  const passwordOk = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
  if (!user || !passwordOk || !user.isActive) {
    throttle.registerFailure(throttleKey);
    await recordAuthEvent({
      userId: user?.id ?? null,
      username,
      event: "login_failed",
      req,
      detail: !user ? "unknown user" : !passwordOk ? "wrong password" : "disabled account",
    });
    res.status(401).json({ error: "Неверный логин или пароль" });
    return;
  }

  const token = createToken();
  const expiresAt = sessionExpiry();
  await db.insert(sessionsTable).values({
    userId: user.id,
    tokenHash: hashToken(token),
    userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
    ip: clientIp(req),
    expiresAt,
  });
  await db
    .update(usersTable)
    .set({ lastLoginAt: new Date() })
    .where(eq(usersTable.id, user.id));

  throttle.reset(throttleKey);
  await recordAuthEvent({ userId: user.id, username, event: "login", req });
  setSessionCookie(res, token, expiresAt);

  res.json(
    GetCurrentUserResponse.parse({
      user: {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
      },
      expiresAt,
      viaDevice: false,
    }),
  );
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  const token = req.cookies?.[SESSION_COOKIE];
  if (typeof token === "string" && token) {
    const resolved = await resolveSession(req);
    await db.delete(sessionsTable).where(eq(sessionsTable.tokenHash, hashToken(token)));
    if (resolved) {
      await recordAuthEvent({
        userId: resolved.user.id,
        username: resolved.user.username,
        event: "logout",
        req,
      });
    }
  }
  // The device cookie stays: the tablet remains trusted for the next PIN login.
  clearSessionCookie(res);
  res.status(204).send();
});

/**
 * Creates the account named by `AUTH_ROOT_USERNAME` at startup.
 *
 * Without it a fresh deployment has no way in. The account is marked protected,
 * so it cannot be disabled or demoted from the interface.
 *
 * The password is only ever applied when the account is created, or when
 * `AUTH_ROOT_RESET_PASSWORD=1` is set explicitly. Rewriting it on every start
 * would silently undo a password changed in the interface — and, worse, would
 * invalidate every session of that account on each restart.
 */
export async function ensureRootAdmin(): Promise<void> {
  const username = process.env["AUTH_ROOT_USERNAME"];
  const password = process.env["AUTH_ROOT_PASSWORD"];
  const forceReset = process.env["AUTH_ROOT_RESET_PASSWORD"] === "1";

  if (!username || !password) {
    const [anyUser] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
    if (!anyUser) {
      // Магазин, заведённый владельцем сервиса, входит по одноразовой ссылке: аккаунта
      // ещё нет, и это нормально. Предупреждение остаётся только для случая, когда ни
      // пользователей, ни выданной ссылки нет — тогда войти действительно некому.
      const pending = await hasPendingSetupToken();
      if (pending) {
        logger.info("Ожидается первый вход по одноразовой ссылке: аккаунт создаст владелец магазина");
      } else {
        logger.warn(
          "No users exist and AUTH_ROOT_USERNAME/AUTH_ROOT_PASSWORD are not set: nobody can sign in",
        );
      }
    }
    return;
  }

  const normalized = normalizeUsername(username);
  const [existing] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.username, normalized));

  if (existing) {
    await db
      .update(usersTable)
      .set({
        isProtected: true,
        role: "admin",
        isActive: true,
        ...(forceReset ? { passwordHash: hashPassword(password) } : {}),
      })
      .where(eq(usersTable.id, existing.id));
    if (forceReset) {
      // A reset must also end the sessions opened with the old password.
      const removed = await db
        .delete(sessionsTable)
        .where(eq(sessionsTable.userId, existing.id))
        .returning({ id: sessionsTable.id });
      logger.warn(
        { username: normalized, sessions: removed.length },
        "Root admin password reset from the environment",
      );
    } else {
      logger.info({ username: normalized }, "Root admin is present");
    }
    return;
  }

  await db.insert(usersTable).values({
    username: normalized,
    passwordHash: hashPassword(password),
    displayName: process.env["AUTH_ROOT_DISPLAY_NAME"] ?? "Администратор",
    role: "admin",
    isProtected: true,
  });
  logger.info({ username: normalized }, "Root admin created from the environment");
}

/**
 * Resolves the trusted-device cookie.
 *
 * The token only unlocks the user picker and PIN entry for the account that was
 * signed in when the device was trusted — it never grants access to data.
 */
async function resolveDevice(req: Request) {
  const token = req.cookies?.[DEVICE_COOKIE];
  if (typeof token !== "string" || !token) return null;

  const [device] = await db
    .select()
    .from(devicesTable)
    .where(
      and(
        eq(devicesTable.tokenHash, hashToken(token)),
        isNull(devicesTable.revokedAt),
        gt(devicesTable.expiresAt, new Date()),
      ),
    );
  if (!device) return null;

  const [owner] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, device.userId));
  if (!owner || !owner.isActive) return null;

  return { device, owner };
}

/** The account the device belongs to must still have a PIN set. */
async function deviceUsers(ownerId: number) {
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, ownerId));
  const [pin] = await db
    .select()
    .from(devicePinsTable)
    .where(eq(devicePinsTable.userId, ownerId));
  if (!owner) return [];
  return [
    {
      id: owner.id,
      displayName: owner.displayName,
      hasPin: Boolean(pin),
    },
  ];
}

router.get("/auth/device", async (req, res): Promise<void> => {
  const resolved = await resolveDevice(req);
  if (!resolved) {
    res.status(401).json({ error: "Устройство не доверено" });
    return;
  }
  res.json(
    GetTrustedDeviceResponse.parse({
      id: resolved.device.id,
      name: resolved.device.name,
      expiresAt: resolved.device.expiresAt,
      users: await deviceUsers(resolved.device.userId),
    }),
  );
});

router.get("/auth/device/users", async (req, res): Promise<void> => {
  const resolved = await resolveDevice(req);
  if (!resolved) {
    res.status(401).json({ error: "Устройство не доверено" });
    return;
  }
  res.json(ListDeviceUsersResponse.parse(await deviceUsers(resolved.device.userId)));
});

router.post("/auth/device/pin", async (req, res): Promise<void> => {
  const resolved = await resolveDevice(req);
  if (!resolved) {
    res.status(401).json({ error: "Устройство не доверено" });
    return;
  }

  const parsed = LoginWithPinBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Введите PIN" });
    return;
  }
  // A device is only ever a shortcut for its own account.
  if (parsed.data.userId !== resolved.device.userId) {
    res.status(401).json({ error: "Неверный PIN" });
    return;
  }

  const [pin] = await db
    .select()
    .from(devicePinsTable)
    .where(eq(devicePinsTable.userId, resolved.device.userId));
  const now = Date.now();

  if (!pin) {
    res.status(400).json({ error: "PIN не задан. Войдите паролем." });
    return;
  }
  if (pin.lockedUntil && pin.lockedUntil.getTime() > now) {
    const minutes = Math.ceil((pin.lockedUntil.getTime() - now) / 60000);
    res.status(423).json({ error: `PIN заблокирован. Повторите через ${minutes} мин.` });
    return;
  }

  const pinOk = await verifyPassword(parsed.data.pin, pin.pinHash);
  if (!pinOk) {
    const failures = (pin.lockedUntil && pin.lockedUntil.getTime() <= now ? 0 : pin.failedAttempts) + 1;
    await db
      .update(devicePinsTable)
      .set({
        failedAttempts: failures,
        lockedUntil: failures >= PIN_MAX_ATTEMPTS ? new Date(now + PIN_LOCK_MS) : null,
        updatedAt: new Date(),
      })
      .where(eq(devicePinsTable.userId, resolved.device.userId));
    await recordAuthEvent({
      userId: resolved.owner.id,
      username: resolved.owner.username,
      event: "pin_failed",
      req,
      detail: `attempt ${failures}`,
    });
    res.status(401).json({ error: "Неверный PIN" });
    return;
  }

  await db
    .update(devicePinsTable)
    .set({ failedAttempts: 0, lockedUntil: null, updatedAt: new Date() })
    .where(eq(devicePinsTable.userId, resolved.device.userId));
  await db
    .update(devicesTable)
    .set({ lastUsedAt: new Date() })
    .where(eq(devicesTable.id, resolved.device.id));

  const token = createToken();
  const expiresAt = new Date(now + PIN_SESSION_TTL_MS);
  await db.insert(sessionsTable).values({
    userId: resolved.owner.id,
    tokenHash: hashToken(token),
    userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
    ip: clientIp(req),
    deviceId: resolved.device.id,
    expiresAt,
  });
  await recordAuthEvent({
    userId: resolved.owner.id,
    username: resolved.owner.username,
    event: "pin_login",
    req,
    detail: resolved.device.name,
  });
  setSessionCookie(res, token, expiresAt);

  res.json(
    GetCurrentUserResponse.parse({
      user: {
        id: resolved.owner.id,
        username: resolved.owner.username,
        displayName: resolved.owner.displayName,
        role: resolved.owner.role,
      },
      expiresAt,
      viaDevice: true,
    }),
  );
});

/**
 * Trusts the current browser as a warehouse device.
 *
 * Only an administrator can do this, and it is the administrator's password that
 * was just used — so a stolen tablet never becomes trusted on its own.
 */
router.post("/auth/devices", async (req, res): Promise<void> => {
  const parsed = TrustCurrentDeviceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Укажите название устройства" });
    return;
  }
  if (!req.user || req.user.role !== "admin") {
    res.status(403).json({ error: "Доверенное устройство добавляет администратор" });
    return;
  }

  const token = createToken(32);
  const expiresAt = deviceExpiry();
  const [device] = await db
    .insert(devicesTable)
    .values({
      userId: req.user.id,
      name: parsed.data.name.trim(),
      tokenHash: hashToken(token),
      userAgent: req.headers["user-agent"]?.slice(0, 300) ?? null,
      createdBy: req.user.id,
      expiresAt,
    })
    .returning();

  await recordAuthEvent({
    userId: req.user.id,
    username: req.user.username,
    event: "device_trusted",
    req,
    detail: device.name,
  });

  res.cookie(DEVICE_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: isProduction(),
    path: "/",
    expires: expiresAt,
  });
  res.status(201).json({ id: device.id, name: device.name, expiresAt: device.expiresAt });
});

export { DEVICE_COOKIE };
export default router;
