/**
 * Первый вход нового магазина по одноразовой ссылке.
 *
 * Владелец сервиса заводит магазин и выдаёт ссылку; владелец магазина открывает её и сам
 * задаёт логин и пароль. Пароль нигде не пересылается и его не видит никто, кроме
 * владельца магазина.
 *
 * Здесь же лежит создание ссылок — этим пользуется скрипт провижининга, когда заводит
 * новый магазин на сервере.
 */
import { and, eq, gt, isNull } from "drizzle-orm";
import { setupTokensTable, db, usersTable } from "@workspace/db";
import { createToken, hashPassword, hashToken, normalizeUsername } from "./auth";

/** Сколько живёт ссылка: сутки — достаточно, чтобы передать её человеку. */
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

/** Состояние ссылки для экрана первого входа. */
export type SetupTokenState =
  | { status: "valid"; shopName: string }
  | { status: "unknown" }
  | { status: "used" }
  | { status: "expired" };

/**
 * Создаёт ссылку для магазина и возвращает её токен в открытом виде.
 *
 * В базе остаётся только хеш: дамп базы не даёт войти по чужой ссылке — ровно как с
 * сессиями. Открытый токен показывается один раз, тому, кто заводит магазин.
 */
export async function createSetupToken(shopName: string, createdBy?: string) {
  const token = createToken();
  const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_MS);
  await db.insert(setupTokensTable).values({
    tokenHash: hashToken(token),
    shopName,
    createdBy: createdBy ?? null,
    expiresAt,
  });
  return { token, expiresAt };
}

/**
 * Проверяет ссылку, ничего не меняя.
 *
 * Отдельно различаем «использована» и «истекла»: человеку важно понять, просить новую
 * ссылку или он просто открыл старую. Обе причины показываются разными словами.
 */
export async function inspectSetupToken(token: string): Promise<SetupTokenState> {
  const [row] = await db
    .select()
    .from(setupTokensTable)
    .where(eq(setupTokensTable.tokenHash, hashToken(token)));
  if (!row) return { status: "unknown" };
  if (row.usedAt) return { status: "used" };
  if (row.expiresAt.getTime() <= Date.now()) return { status: "expired" };
  return { status: "valid", shopName: row.shopName };
}

/**
 * Гасит ссылку и создаёт администратора магазина.
 *
 * Ссылка гасится тем же запросом, что проверяет её пригодность: два одновременных
 * открытия одной ссылки не должны создать двух администраторов.
 */
export async function redeemSetupToken(input: {
  token: string;
  username: string;
  displayName: string;
  password: string;
}): Promise<{ ok: true; username: string } | { ok: false; reason: string }> {
  const state = await inspectSetupToken(input.token);
  if (state.status === "unknown") return { ok: false, reason: "Ссылка не найдена" };
  if (state.status === "used") return { ok: false, reason: "Ссылка уже использована" };
  if (state.status === "expired") return { ok: false, reason: "Срок действия ссылки истёк" };

  const username = normalizeUsername(input.username);
  const [taken] = await db.select({ id: usersTable.id }).from(usersTable).where(eq(usersTable.username, username));
  if (taken) return { ok: false, reason: "Такой логин уже занят" };

  const [used] = await db
    .update(setupTokensTable)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(setupTokensTable.tokenHash, hashToken(input.token)),
        isNull(setupTokensTable.usedAt),
        gt(setupTokensTable.expiresAt, new Date()),
      ),
    )
    .returning({ id: setupTokensTable.id });
  // Пустой ответ означает, что ссылку успели погасить параллельно.
  if (!used) return { ok: false, reason: "Ссылка уже использована" };

  const [anyUser] = await db.select({ id: usersTable.id }).from(usersTable).limit(1);
  await db.insert(usersTable).values({
    username,
    displayName: input.displayName.trim() || "Администратор",
    passwordHash: hashPassword(input.password),
    role: "admin",
    isActive: true,
    // Первый аккаунт магазина защищён: иначе магазин может закрыть себе вход.
    isProtected: !anyUser,
  });

  return { ok: true, username };
}

/** Есть ли выданная и ещё не использованная ссылка: нужно при старте службы. */
export async function hasPendingSetupToken(): Promise<boolean> {
  const rows = await db
    .select({ id: setupTokensTable.id })
    .from(setupTokensTable)
    .where(and(isNull(setupTokensTable.usedAt), gt(setupTokensTable.expiresAt, new Date())))
    .limit(1);
  return rows.length > 0;
}
