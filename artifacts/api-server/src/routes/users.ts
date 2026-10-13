import { Router, type IRouter, type Request } from "express";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import {
  devicePinsTable,
  devicesTable,
  db,
  sessionsTable,
  usersTable,
} from "@workspace/db";
import {
  CreateUserBody,
  ListUsersResponse,
  UpdateUserBody,
  UpdateUserParams,
  UpdateUserResponse,
} from "@workspace/api-zod";
import { hashPassword, normalizeUsername, passwordProblem, pinProblem } from "../lib/auth";
import { requireRole } from "../middlewares/auth";
import { recordAuthEvent } from "./auth-events";

const router: IRouter = Router();

/** Every endpoint here is administrative. */
router.use("/users", requireRole("admin"));

async function describeUsers(rows: Array<typeof usersTable.$inferSelect>) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);

  const pins = await db
    .select({ userId: devicePinsTable.userId })
    .from(devicePinsTable)
    .where(inArray(devicePinsTable.userId, ids));
  const devices = await db
    .select({ userId: devicesTable.userId })
    .from(devicesTable)
    .where(and(inArray(devicesTable.userId, ids), isNull(devicesTable.revokedAt)));
  const sessions = await db
    .select({ userId: sessionsTable.userId })
    .from(sessionsTable)
    .where(inArray(sessionsTable.userId, ids));

  const count = (list: Array<{ userId: number }>, userId: number) =>
    list.filter((entry) => entry.userId === userId).length;

  return rows.map((user) => ({
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    isActive: user.isActive,
    isProtected: user.isProtected,
    hasPin: pins.some((pin) => pin.userId === user.id),
    deviceCount: count(devices, user.id),
    sessionCount: count(sessions, user.id),
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
  }));
}

router.get("/users", async (_req, res): Promise<void> => {
  const rows = await db.select().from(usersTable).orderBy(usersTable.id);
  res.json(ListUsersResponse.parse(await describeUsers(rows)));
});

router.post("/users", async (req: Request, res): Promise<void> => {
  const parsed = CreateUserBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Проверьте логин, имя и пароль" });
    return;
  }

  const username = normalizeUsername(parsed.data.username);
  if (username.length < 3) {
    res.status(400).json({ error: "Логин должен быть не короче 3 символов" });
    return;
  }
  const problem = passwordProblem(parsed.data.password);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }

  const [existing] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.username, username));
  if (existing) {
    res.status(400).json({ error: "Такой логин уже занят" });
    return;
  }

  const [created] = await db
    .insert(usersTable)
    .values({
      username,
      passwordHash: hashPassword(parsed.data.password),
      displayName: parsed.data.displayName.trim(),
      role: parsed.data.role,
    })
    .returning();

  await recordAuthEvent({
    userId: req.user?.id ?? null,
    username: req.user?.username ?? null,
    event: "user_created",
    req,
    detail: `created ${created.username} (${created.role})`,
  });

  res.status(201).json(UpdateUserResponse.parse((await describeUsers([created]))[0]));
});

router.patch("/users/:id", async (req: Request, res): Promise<void> => {
  const params = UpdateUserParams.safeParse(req.params);
  const body = UpdateUserBody.safeParse(req.body);
  if (!params.success || !body.success) {
    res.status(400).json({ error: "Неверные данные сотрудника" });
    return;
  }

  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, params.data.id));
  if (!user) {
    res.status(400).json({ error: "Сотрудник не найден" });
    return;
  }

  const changes = body.data;
  const isSelf = req.user?.id === user.id;

  // A protected account is the only way back into a locked deployment, so it
  // can never be disabled or demoted from the interface.
  if (user.isProtected && (changes.isActive === false || (changes.role && changes.role !== "admin"))) {
    res.status(403).json({ error: "Основной администратор не может быть отключён или понижен" });
    return;
  }
  if (isSelf && changes.isActive === false) {
    res.status(403).json({ error: "Нельзя отключить свою учётную запись" });
    return;
  }
  if (isSelf && changes.role === "staff" && user.role === "admin") {
    const [otherAdmin] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true)));
    if (otherAdmin && otherAdmin.id === user.id) {
      res.status(403).json({ error: "В системе должен остаться хотя бы один администратор" });
      return;
    }
  }

  if (changes.password !== undefined) {
    const problem = passwordProblem(changes.password);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
  }
  if (changes.pin !== undefined && changes.pin !== null) {
    const problem = pinProblem(changes.pin);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
  }

  const profileChanges = {
    ...(changes.displayName !== undefined ? { displayName: changes.displayName.trim() } : {}),
    ...(changes.role !== undefined ? { role: changes.role } : {}),
    ...(changes.isActive !== undefined ? { isActive: changes.isActive } : {}),
    ...(changes.password !== undefined ? { passwordHash: hashPassword(changes.password) } : {}),
  };
  // Drizzle rejects an empty SET clause, which is what a PIN-only change is.
  const [updated] = Object.keys(profileChanges).length
    ? await db
        .update(usersTable)
        .set(profileChanges)
        .where(eq(usersTable.id, user.id))
        .returning()
    : [user];

  let revokedSessions = 0;
  let revokedDevices = 0;

  // A new password or a new PIN invalidates what was issued before, otherwise a
  // reset would not actually take access away from a lost phone. Sessions opened
  // through a trusted device are ended as well — a PIN is derived from the
  // password, so the password is the root of that trust.
  if (changes.password !== undefined) {
    const removed = await db
      .delete(sessionsTable)
      .where(eq(sessionsTable.userId, user.id))
      .returning({ id: sessionsTable.id });
    revokedSessions = removed.length;
  }
  if (changes.pin !== undefined) {
    // Only sessions opened through a device are closed: the PIN is what got them
    // in. Devices themselves are a separate, explicit grant and are revoked from
    // their own endpoint — revoking them here would kill the tablet this very
    // request came from.
    await db
      .delete(sessionsTable)
      .where(and(eq(sessionsTable.userId, user.id), isNotNull(sessionsTable.deviceId)));

    await db.delete(devicePinsTable).where(eq(devicePinsTable.userId, user.id));
    if (changes.pin) {
      await db.insert(devicePinsTable).values({
        userId: user.id,
        pinHash: hashPassword(changes.pin),
      });
    }
  }

  if (changes.isActive === false) {
    const removed = await db
      .delete(sessionsTable)
      .where(eq(sessionsTable.userId, user.id))
      .returning({ id: sessionsTable.id });
    revokedSessions = Math.max(revokedSessions, removed.length);
    await db
      .update(devicesTable)
      .set({ revokedAt: new Date() })
      .where(and(eq(devicesTable.userId, user.id), isNull(devicesTable.revokedAt)));
  }

  await recordAuthEvent({
    userId: req.user?.id ?? null,
    username: req.user?.username ?? null,
    event: "user_updated",
    req,
    detail: [
      `target ${updated.username}`,
      changes.password !== undefined ? "password reset" : null,
      changes.pin !== undefined ? "pin reset" : null,
      changes.role ? `role ${changes.role}` : null,
      changes.isActive !== undefined ? `active ${changes.isActive}` : null,
      revokedSessions ? `sessions revoked ${revokedSessions}` : null,
      revokedDevices ? `devices revoked ${revokedDevices}` : null,
    ]
      .filter(Boolean)
      .join(", "),
  });

  res.json(UpdateUserResponse.parse((await describeUsers([updated]))[0]));
});

router.delete("/users/:id/devices", async (req: Request, res): Promise<void> => {
  const params = UpdateUserParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Неверный идентификатор" });
    return;
  }
  const [user] = await db
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, params.data.id));
  if (!user) {
    res.status(400).json({ error: "Сотрудник не найден" });
    return;
  }

  const removedSessions = await db
    .delete(sessionsTable)
    .where(eq(sessionsTable.userId, user.id))
    .returning({ id: sessionsTable.id });
  const removedDevices = await db
    .update(devicesTable)
    .set({ revokedAt: new Date() })
    .where(and(eq(devicesTable.userId, user.id), isNull(devicesTable.revokedAt)))
    .returning({ id: devicesTable.id });

  await recordAuthEvent({
    userId: req.user?.id ?? null,
    username: req.user?.username ?? null,
    event: "access_revoked",
    req,
    detail: `target ${user.username}, devices ${removedDevices.length}, sessions ${removedSessions.length}`,
  });

  res.status(204).send();
});

export default router;
