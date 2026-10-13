import type { NextFunction, Request, Response } from "express";
import { resolveSession } from "../routes/auth";

export type AuthenticatedUser = {
  id: number;
  username: string;
  displayName: string;
  role: "admin" | "staff";
  viaDevice: boolean;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

/**
 * Paths that stay open without a session.
 *
 * Everything else is closed by default: a new endpoint is protected unless
 * somebody deliberately adds it here, which is the safer direction for a stock
 * system. The device endpoints are open because they authenticate themselves —
 * with the trusted-device cookie or with a PIN.
 */
const PUBLIC_PATHS = new Set([
  "/healthz",
  "/auth/login",
  "/auth/device",
  "/auth/device/users",
  "/auth/device/pin",
  // Первый вход нового магазина: ссылка сама себя удостоверяет, а до неё войти некому.
  "/setup",
]);

export const isPublicPath = (path: string) =>
  PUBLIC_PATHS.has(path) || path.startsWith("/setup/");

export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (isPublicPath(req.path)) {
    next();
    return;
  }

  const resolved = await resolveSession(req);
  if (!resolved) {
    res.status(401).json({ error: "Требуется вход" });
    return;
  }

  req.user = {
    id: resolved.user.id,
    username: resolved.user.username,
    displayName: resolved.user.displayName,
    role: resolved.user.role,
    viaDevice: resolved.session.deviceId !== null,
  };
  next();
}

/** Administrative endpoints: catalog, bouquets, users, trusted devices. */
export function requireRole(role: "admin") {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ error: "Требуется вход" });
      return;
    }
    if (req.user.role !== role) {
      res.status(403).json({ error: "Недостаточно прав для этой операции" });
      return;
    }
    next();
  };
}
