/**
 * Shared helper that resets the database to the demo assortment.
 *
 * The verification scripts that post real movements used to depend on whoever
 * ran last: a leftover product from a previous run silently changed what
 * "unknown product" meant. Each of them now seeds first, so a check always
 * starts from the same catalog.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function seedDatabase() {
  const databaseUrl =
    process.env.DATABASE_URL ??
    "postgresql://flower_stock:flower_stock@127.0.0.1:5432/flower_stock";

  try {
    const output = execFileSync(
      "pnpm",
      ["--filter", "@workspace/scripts", "run", "seed"],
      {
        cwd: root,
        env: { ...process.env, DATABASE_URL: databaseUrl },
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        encoding: "utf8",
      },
    );
    const summary = output.trim().split("\n").slice(-6).join(" ");
    console.log(`seed: ${summary.replace(/\s+/g, " ").slice(0, 120)}`);
  } catch (error) {
    const details = String(error.stdout ?? "") + String(error.stderr ?? "");
    throw new Error(`Could not seed the database before the check:\n${details || error.message}`);
  }
}
