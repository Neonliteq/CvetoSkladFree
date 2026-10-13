import type { Request } from "express";
import { authEventsTable, db } from "@workspace/db";
import { logger } from "../lib/logger";

/** Trusts the reverse proxy that terminates TLS in front of the app. */
export function clientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
  return (first ?? req.socket.remoteAddress ?? "").trim() || null;
}

/**
 * Writes an entry to the login audit.
 *
 * Kept in its own module so the auth routes and the user-management routes can
 * both use it without importing each other. Auditing must never break the
 * request it describes, so failures are logged and swallowed.
 */
export async function recordAuthEvent(entry: {
  userId?: number | null;
  username?: string | null;
  event: string;
  req: Request;
  detail?: string;
}): Promise<void> {
  try {
    await db.insert(authEventsTable).values({
      userId: entry.userId ?? null,
      username: entry.username ?? null,
      event: entry.event,
      ip: clientIp(entry.req),
      userAgent: entry.req.headers["user-agent"]?.slice(0, 300) ?? null,
      detail: entry.detail ?? null,
    });
  } catch (error) {
    logger.warn({ err: error }, "Could not record an auth event");
  }
}
