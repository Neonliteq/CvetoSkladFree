/**
 * Renders the PWA icons from the source SVGs.
 *
 * A headless screenshot of an SVG document does not scale it to the window, so
 * each icon is embedded in a one-off HTML page that stretches it to the viewport.
 *
 * Usage: node scripts/src/make-icons.mjs
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "..", "..", "artifacts", "flower-stock", "public");
const edge =
  process.env.EDGE_PATH ??
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

const jobs = [
  { source: "app-icon.svg", target: "icon-192.png", size: 192 },
  { source: "app-icon.svg", target: "icon-512.png", size: 512 },
  { source: "app-icon-maskable.svg", target: "icon-maskable-512.png", size: 512 },
];

for (const job of jobs) {
  const svg = readFileSync(path.join(publicDir, job.source), "utf8")
    // The intrinsic `width`/`height` attributes and the CSS sizing both lose to
    // the viewBox when the page is laid out, so the size is forced on the root
    // element with an inline style.
    .replace(/\swidth="\d+"/u, "")
    .replace(/\sheight="\d+"/u, "")
    .replace(
      "<svg",
      `<svg preserveAspectRatio="xMidYMid meet" style="width:${job.size}px;height:${job.size}px;display:block"`,
    );

  const workDir = mkdtempSync(path.join(tmpdir(), "dsh-icon-"));
  const htmlPath = path.join(workDir, "icon.html");
  writeFileSync(
    htmlPath,
    `<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; padding: 0; width: ${job.size}px; height: ${job.size}px; overflow: hidden; }
      svg { width: ${job.size}px !important; height: ${job.size}px !important; display: block; }
    </style></head><body>${svg}</body></html>`,
  );

  const profile = mkdtempSync(path.join(tmpdir(), "dsh-icon-profile-"));
  const target = path.join(publicDir, job.target);
  execFileSync(
    edge,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--user-data-dir=${profile}`,
      `--window-size=${job.size},${job.size}`,
      "--hide-scrollbars",
      `--screenshot=${target}`,
      `file:///${htmlPath.replaceAll("\\", "/")}`,
    ],
    { stdio: "ignore" },
  );

  rmSync(workDir, { recursive: true, force: true });
  rmSync(profile, { recursive: true, force: true });
  console.log(`${job.target}: ${statSync(target).size} bytes`);
}
