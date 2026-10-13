import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  // drizzle-kit feeds this path to `glob`, which treats backslashes as escape
  // characters — on Windows `path.join` produces `G:\...` and the glob matches
  // nothing. Forward slashes are valid separators on every platform.
  schema: path
    .join(__dirname, "./src/schema/index.ts")
    .replaceAll("\\", "/"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
