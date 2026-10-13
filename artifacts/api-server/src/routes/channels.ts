/**
 * Messenger linking endpoints.
 *
 * Access through a bot is decided by `channel_identities`, so these routes are
 * how a link is created and revoked. Claiming is available to any signed-in user
 * because it links *their own* messenger account; the list and revocation are
 * administrative.
 */
import { Router, type IRouter, type Request } from "express";
import { desc, eq } from "drizzle-orm";
import { channelIdentitiesTable, db, usersTable } from "@workspace/db";
import {
  ClaimChannelLinkBody,
  ClaimChannelLinkResponse,
  ListChannelLinksResponse,
  UnlinkChannelParams,
} from "@workspace/api-zod";
import { claimLinkCode, unlinkIdentity } from "../lib/channel-access.ts";
import { requireRole } from "../middlewares/auth.ts";
import { recordAuthEvent } from "./auth-events.ts";

const router: IRouter = Router();

router.get("/channels", requireRole("admin"), async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      identity: channelIdentitiesTable,
      displayName: usersTable.displayName,
    })
    .from(channelIdentitiesTable)
    .innerJoin(usersTable, eq(channelIdentitiesTable.userId, usersTable.id))
    .orderBy(desc(channelIdentitiesTable.linkedAt));

  res.json(
    ListChannelLinksResponse.parse(
      rows.map((row) => ({
        id: row.identity.id,
        userId: row.identity.userId,
        userDisplayName: row.displayName,
        channel: row.identity.channel,
        externalId: row.identity.externalId,
        displayName: row.identity.displayName,
        username: row.identity.username,
        linkedAt: row.identity.linkedAt,
        lastSeenAt: row.identity.lastSeenAt,
        isActive: row.identity.isActive,
      })),
    ),
  );
});

/**
 * Claims a linking code for the signed-in account.
 *
 * Open to every role: a worker links their own messenger, and the code itself is
 * the proof that they control the account that asked for access.
 */
router.post("/channels/claim", async (req: Request, res): Promise<void> => {
  const parsed = ClaimChannelLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Введите код из мессенджера" });
    return;
  }
  if (!req.user) {
    res.status(401).json({ error: "Требуется вход" });
    return;
  }

  const result = await claimLinkCode(parsed.data.code, req.user.id);
  if (!result.ok) {
    res.status(400).json({ error: result.reason });
    return;
  }

  await recordAuthEvent({
    userId: req.user.id,
    username: req.user.username,
    event: "channel_linked",
    req,
    detail: result.channel,
  });

  res.json(
    ClaimChannelLinkResponse.parse({
      channel: result.channel,
      userDisplayName: result.userDisplayName,
    }),
  );
});

router.delete("/channels/:id", requireRole("admin"), async (req: Request, res): Promise<void> => {
  const params = UnlinkChannelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: "Неверный идентификатор" });
    return;
  }
  const [identity] = await db
    .select()
    .from(channelIdentitiesTable)
    .where(eq(channelIdentitiesTable.id, params.data.id));
  if (!identity) {
    res.status(400).json({ error: "Привязка не найдена" });
    return;
  }

  await unlinkIdentity(identity.channel, identity.externalId);
  await recordAuthEvent({
    userId: req.user?.id ?? null,
    username: req.user?.username ?? null,
    event: "channel_unlinked",
    req,
    detail: `${identity.channel}:${identity.externalId}`,
  });

  res.status(204).send();
});

export default router;
