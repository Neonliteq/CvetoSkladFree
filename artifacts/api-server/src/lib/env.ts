// Loads `.env` from the repository root into `process.env`.
//
// This module MUST be imported before any module that reads configuration at
// import time (`@workspace/db` throws when `DATABASE_URL` is missing, the
// OpenAI integration throws when its key is missing). ESM evaluates imports in
// the order they appear in the importing module, so `import "./lib/env"` has to
// stay the first import of `index.ts`.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const candidates = [
  // repo root, resolved from src/lib/env.ts during development
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", ".env"),
  // working directory fallbacks (bundled production build)
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", "..", ".env"),
];

const envPath = candidates.find((candidate) => existsSync(candidate));

if (envPath) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    const value = rawValue.trim().replace(/^(["'])(.*)\1$/u, "$2");
    process.env[key] = value;
  }
}
