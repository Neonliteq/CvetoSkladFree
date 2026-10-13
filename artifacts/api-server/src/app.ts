import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

// In production the app sits behind nginx, which terminates TLS and forwards the
// request. Without this, `req.ip` is the proxy address: the login throttle would
// count every user under one key, and the audit log would record the wrong
// address. The value stays explicit rather than `true`, which would trust a
// client-supplied X-Forwarded-For from anywhere.
const trustedProxies = process.env["TRUSTED_PROXY"];
if (trustedProxies) {
  app.set(
    "trust proxy",
    /^\d+$/u.test(trustedProxies) ? Number(trustedProxies) : trustedProxies,
  );
}

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
// Sessions travel in an httpOnly cookie, so the browser must be allowed to send
// credentials and the origin cannot stay a wildcard.
app.use(
  cors({
    origin: process.env["APP_ORIGIN"]?.split(",").map((value) => value.trim()) ?? true,
    credentials: true,
  }),
);
app.use(cookieParser());
// Invoice photos travel as base64 data URLs (~33% larger than the file), so the
// default 100 kB JSON limit has to be raised for that endpoint.
app.use(express.json({ limit: "12mb" }));
app.use(express.urlencoded({ extended: true, limit: "12mb" }));

app.use("/api", router);

export default app;
