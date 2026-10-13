// Cross-platform drop-in for the original `export NODE_ENV=development && ...`
// dev script. The POSIX `export` prefix and `&&` chaining do not work under
// cmd.exe, so the sequencing lives here instead.
import { spawnSync } from "node:child_process";

process.env.NODE_ENV = "development";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

for (const args of [
  ["run", "build"],
  ["run", "start"],
]) {
  const result = spawnSync(pnpm, args, {
    stdio: "inherit",
    env: process.env,
    shell: process.platform === "win32",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
