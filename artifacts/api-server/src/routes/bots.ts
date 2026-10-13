/**
 * Bot endpoints.
 *
 * `POST /bots/simulate` runs the bot pipeline — access control, linking, the
 * assistant — with a caller-supplied message, so the behaviour can be verified
 * without a real messenger. It is administrative, because it can post stock
 * operations on behalf of another account; it is not a public webhook.
 */
import { Router, type IRouter } from "express";
import { resolveChannelAuthor } from "../lib/channel-access";
import { answerIncomingMessage } from "../lib/bot-handler";
import { assistantDependencies } from "./inventory";
import { requireRole } from "../middlewares/auth";

const router: IRouter = Router();

router.post("/bots/simulate", requireRole("admin"), async (req, res): Promise<void> => {
  const { channel, externalId, text, displayName, authorId } = req.body ?? {};
  if (
    (channel !== "telegram" && channel !== "max") ||
    typeof externalId !== "string" ||
    !externalId ||
    typeof text !== "string"
  ) {
    res.status(400).json({ error: "Нужны channel, externalId и text" });
    return;
  }

  // The author is derived from the link, exactly as a real message would be.
  const author = await resolveChannelAuthor(channel, externalId);
  const dependencies = assistantDependencies(
    typeof authorId === "number" ? authorId : author?.userId ?? null,
  );

  let reply = "";
  await answerIncomingMessage(
    { channel, externalId, text, displayName: displayName ?? null },
    dependencies,
    async (answer) => {
      reply = answer;
    },
  );

  res.json({
    reply,
    linked: Boolean(author),
    authorId: author?.userId ?? null,
  });
});

export default router;
