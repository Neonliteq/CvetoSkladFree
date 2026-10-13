// Cross-platform replacement for the original POSIX `sh -c` preinstall guard.
//
// Original behaviour (Linux):
//   1. remove any package-lock.json / yarn.lock so pnpm stays the only lockfile
//   2. abort the install when the package manager is not pnpm
//
// This version runs anywhere Node.js runs (including Windows) and keeps the
// same guarantees.
import { rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const workspaceRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

for (const lockfile of ["package-lock.json", "yarn.lock"]) {
  rmSync(path.join(workspaceRoot, lockfile), { force: true });
}

const userAgent = process.env.npm_config_user_agent ?? "";

if (!userAgent.startsWith("pnpm/")) {
  console.error(
    [
      "This workspace must be installed with pnpm, not npm or yarn.",
      "",
      "  corepack enable",
      "  pnpm install",
      "",
    ].join("\n"),
  );
  process.exit(1);
}
