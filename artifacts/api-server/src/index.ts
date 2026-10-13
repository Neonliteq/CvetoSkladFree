// Must stay the first import: it populates process.env before any module that
// validates configuration at import time is evaluated.
import "./lib/env";
import app from "./app";
import { logger } from "./lib/logger";
import { ensureRootAdmin } from "./routes/auth";
import { provideBotDependencies } from "./lib/bot-dependencies";
import { startMaxBot, stopMaxBot } from "./lib/max-bot";
import { startTelegramBot, stopTelegramBot } from "./lib/telegram-bot";
import { assistantDependencies } from "./routes/inventory";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const shutdown = () => {
  stopTelegramBot();
  stopMaxBot();
  process.exit(0);
};

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // The bots run the same assistant as the web interface, so they need the same
  // collaborators. Registering them here — the only module that sees both the
  // routes and the transports — is what keeps the two layers from importing each
  // other.
  provideBotDependencies(assistantDependencies(null));

  // A deployment with no accounts is unusable, so the root admin is ensured
  // before anything else can be attempted.
  void ensureRootAdmin()
    .catch((error) => logger.error({ err: error }, "Could not prepare the root admin"))
    .then(() => Promise.all([startTelegramBot(), startMaxBot()]))
    .catch((error) => logger.error({ err: error }, "Could not start the bots"));
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
