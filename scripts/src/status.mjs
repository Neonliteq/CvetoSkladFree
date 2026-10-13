/**
 * Сводка фактов о проекте для новой сессии.
 *
 * Смысл скрипта — не «красиво показать состояние», а не дать документации
 * разойтись с кодом. Он читает то, что можно проверить машинно: ревизию git,
 * список проверок с числом утверждений, ссылки в AGENTS.md и заявленные в
 * playbook.md числа. Расхождение — это предупреждение, а не молчание.
 *
 * Usage: node scripts/src/status.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (relative) => readFileSync(path.join(root, relative), "utf8");

const git = (...args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};

let warnings = 0;
const warn = (message) => {
  warnings += 1;
  console.log(`  ⚠ ${message}`);
};

console.log("=== Репозиторий ===");
const branch = git("rev-parse", "--abbrev-ref", "HEAD") ?? "неизвестно";
const revision = git("rev-parse", "--short", "HEAD") ?? "неизвестно";
const subject = git("log", "-1", "--pretty=%s") ?? "";
const changed = (git("status", "--porcelain") ?? "").split("\n").filter(Boolean);
const dirty = changed.length;
console.log(`  ветка:    ${branch}`);
console.log(`  ревизия:  ${revision} — ${subject}`);
// Незакоммиченные правки — нормальное состояние рабочей копии, а не повод для
// предупреждения: важно только, чтобы сессия знала, что код отличается от HEAD.
console.log(`  изменено: ${dirty} файл(ов) ${dirty ? "(рабочая копия отличается от HEAD)" : ""}`);

// Правило ведения журнала (см. AGENTS.md) проверяется здесь, а не на память:
// правки в коде без записи в журнале — это нарушение, и его видно сразу.
if (dirty) {
  // Формат `git status --porcelain` — два символа состояния, пробел, путь. Именно
  // два: у изменённого файла это « M», и срез по фиксированной длине съедал первую
  // букву пути («ocs/journal.md» вместо «docs/journal.md»).
  const paths = changed.map((line) => {
    const path = line.slice(2).trim();
    return path.startsWith('"') ? path.slice(1, -1) : path;
  });
  // Снимки экранов — артефакт проверок: они обновляются при каждом прогоне и
  // записи в журнале не требуют.
  const isMemory = (path) =>
    path === "AGENTS.md" ||
    path === "README.md" ||
    path.startsWith("docs/") ||
    path.startsWith("screenshots/");
  // Если тронуты только документы и снимки — журнал ведётся, придирок нет.
  // state.md при этом не обязателен: в него пишут, только когда меняется
  // состояние проекта, и заставлять трогать его ради галочки вредно.
  if (!paths.every(isMemory) && !paths.includes("docs/journal.md")) {
    warn(
      "рабочая копия изменена, а docs/journal.md не тронут: правило ведения журнала " +
        "(AGENTS.md → «Ведение журнала») требует записи о задаче до отчёта",
    );
  } else if (paths.includes("docs/journal.md")) {
    // «Журнал тронут» ещё не значит «запись про эти правки»: запись могла быть
    // сделана раньше, а код поправлен после неё. Сравнение времени правки ловит
    // этот случай — запись должна быть не старше самого свежего изменения.
    const journal = path.join(root, "docs/journal.md");
    const journalTime = statSync(journal).mtimeMs;
    const newer = paths
      .filter((changedPath) => !isMemory(changedPath))
      .map((changedPath) => ({ path: changedPath, time: statSync(path.join(root, changedPath)).mtimeMs }))
      .filter((entry) => entry.time > journalTime + 1000);
    if (newer.length) {
      warn(
        `журнал старше изменений (${newer.map((entry) => entry.path).join(", ")}): ` +
          "допиши запись о том, что сделано в этот раз",
      );
    }
  }
}

const remoteHead = git("rev-parse", "--short", "origin/main");
const localHead = git("rev-parse", "--short", "main");
if (remoteHead && localHead && remoteHead !== localHead) {
  warn(`локальная main (${localHead}) не совпадает с origin/main (${remoteHead}): не запушено`);
}

// state.md ведёт две ревизии: что выложено на прод и на какой обновлялась сама
// документация. Достаточно, чтобы HEAD совпал хотя бы с одной: иначе документ
// описывает состояние, которого в репозитории уже нет.
const stateText = existsSync(path.join(root, "docs/state.md")) ? read("docs/state.md") : "";
const stateRevisions = [...stateText.matchAll(/ревизия `([0-9a-f]{7,})`/gi)].map(
  (match) => match[1],
);
if (!stateRevisions.length) {
  warn("в docs/state.md нет строки «ревизия `хеш`» — новая сессия не поймёт, что выложено");
} else {
  // Документацию правят несколькими коммитами подряд (журнал, state, скрипт),
  // поэтому её ревизия законно отстаёт на несколько коммитов. Проверяем, что она
  // не «потерялась»: расхождение больше трёх коммитов — сигнал обновить state.md.
  const recent = new Set(
    ["HEAD", "HEAD~1", "HEAD~2", "HEAD~3"]
      .map((ref) => git("rev-parse", "--short", ref))
      .filter(Boolean),
  );
  const matchesHead = (value) =>
    [...recent].some((ref) => value.startsWith(ref) || ref.startsWith(value));
  if (!stateRevisions.some(matchesHead)) {
    warn(
      `docs/state.md говорит про ревизии ${stateRevisions.join(", ")}, а HEAD — ${revision}: ` +
        "обнови строку про прод или строку про документацию",
    );
  } else {
    const [deployed] = stateRevisions;
    if (deployed && !matchesHead(deployed)) {
      console.log(`  на проде:  ${deployed} (в репозитории уже новее — на сервере не выложено)`);
    }
  }
}

console.log("\n=== Документация ===");
const links = [...(existsSync(path.join(root, "AGENTS.md")) ? read("AGENTS.md") : "").matchAll(
  /\]\(([^)]+\.md)\)/g,
)].map((match) => match[1]);
for (const link of new Set(links)) {
  if (!existsSync(path.join(root, link))) warn(`AGENTS.md ссылается на отсутствующий ${link}`);
}
console.log(`  AGENTS.md: ссылок ${new Set(links).size}`);
for (const file of ["docs/playbook.md", "docs/map.md", "docs/state.md", "docs/journal.md",
  "docs/domain-stock.md", "docs/domain-bouquets.md", "docs/domain-analytics.md",
  "docs/domain-assistant.md", "docs/auth.md", "docs/ui.md", "docs/deploy.md", "docs/gotchas.md"]) {
  if (!existsSync(path.join(root, file))) warn(`нет ${file}`);
}
const journalEntries = (read("docs/journal.md").match(/^## \d{4}-/gm) ?? []).length;
console.log(`  журнал:    ${journalEntries} записей`);
const stateDate = stateText.match(/## (\d{4}-\d{2}-\d{2})/)?.[1];
if (stateDate) console.log(`  state.md:  обновлён ${stateDate}`);

console.log("\n=== Проверки ===");
const checkFiles = readdirSync(path.join(root, "scripts/src"))
  .filter((name) => /^check-.*\.(mjs|ts)$/.test(name))
  .sort();
const counts = new Map();
for (const file of checkFiles) {
  const text = read(path.join("scripts/src", file));
  // Число утверждений статически — по вызовам record(. Точное число печатает
  // сама проверка (оно зависит от данных), здесь нужен порядок величины, чтобы
  // заметить устаревшую цифру в playbook.md.
  const assertions = (text.match(/record\(/g) ?? []).length;
  counts.set(file, assertions);
}
console.log(`  скриптов:  ${checkFiles.length}`);
for (const [file, assertions] of counts) {
  console.log(`    ${file.padEnd(36)} ~${assertions}`);
}

// Сверяем числа, заявленные в playbook.md, с подсчётом по коду. Проверка
// «на глаз» тут не годится: таблица в документации быстро устаревает.
const playbook = read("docs/playbook.md");
const claimed = [...playbook.matchAll(/`(check-[a-z0-9-]+\.(?:mjs|ts))`[^|\n]*\|\s*(\d+)/g)]
  .map((match) => [match[1], Number(match[2])]);
let checkedClaims = 0;
for (const [file, expected] of claimed) {
  const actual = counts.get(file);
  if (actual === undefined) {
    warn(`playbook.md упоминает ${file}, которого нет в scripts/src`);
    continue;
  }
  checkedClaims += 1;
  // В проверке бывают утверждения в циклах и хелперах, поэтому статический
  // подсчёт — оценка: расхождение в четверть считаем шумом, больше — сигналом.
  if (actual < expected * 0.75 || actual > expected * 1.6) {
    warn(`${file}: в playbook.md «${expected}», а в коде ~${actual} вызовов record(`);
  }
}
console.log(`  сверено с playbook.md: ${checkedClaims} чисел`);

if (process.argv.includes("--checks")) {
  console.log("\n=== Прогон проверок (--checks) ===");
  console.log("  Запускается по одной: каждая заливает демо-данные и перетрёт соседнюю.");
  console.log("  В прогон входят серверные проверки без внешних зависимостей: сборка");
  console.log("  запускается против локального API, остальное — через браузер, ключ AI или живой сервер.");
  const needsEnvironment = (file) =>
    /-ui\.mjs$/.test(file) ||
    [
      "check-bot-flow.ts", // нужен ключ AI из .env
      "check-pwa.mjs", // нужна собранная сборка
      "check-invoice-vision.mjs", // ключ AI и фото
      "check-invoice-e2e.mjs", // ключ AI
      "check-prod-assistant.mjs", // живой сервер
      "check-voice-support.mjs", // отчёт о среде, а не проверка
    ].includes(file);
  const local = checkFiles.filter((file) => !needsEnvironment(file));
  for (const file of local) {
    const started = Date.now();
    let output = "";
    let ok = false;
    try {
      output = execFileSync("node", [path.join("scripts/src", file)], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        shell: process.platform === "win32",
        env: process.env,
        timeout: 15 * 60 * 1000,
      });
      ok = true;
    } catch (error) {
      output = `${error.stdout ?? ""}${error.stderr ?? ""}`;
    }
    const summary = output.match(/(\d+)\s*\/\s*(\d+)\s*(?:проверок пройдено|checks passed)/)?.[0]
      ?? output.split("\n").filter(Boolean).slice(-1)[0]?.slice(0, 80)
      ?? "нет вывода";
    const failed = output.match(/FAIL[^\n]*/g)?.slice(0, 3) ?? [];
    console.log(`  ${ok ? "✔" : "✖"} ${file.padEnd(36)} ${summary} (${Math.round((Date.now() - started) / 1000)} с)`);
    for (const line of failed) console.log(`      ${line.trim()}`);
    if (!ok) warnings += 1;
  }
  const skipped = checkFiles.filter(needsEnvironment);
  console.log(`\n  Пропущено (${skipped.length}): ${skipped.join(", ")}`);
}

console.log("\n=== Что дальше ===");
console.log("  1. Свежие записи: docs/journal.md (ищи последний раздел перед «Формат записи»).");
console.log("  2. Состояние: docs/state.md — что на проде и что в работе.");
console.log("  3. Стенд и проверки: docs/playbook.md.");
if (warnings) {
  console.log(`\nПредупреждений: ${warnings}. Их стоит закрыть до начала работы.`);
} else {
  console.log("\nРасхождений между документацией и кодом не нашлось.");
}
process.exit(warnings ? 1 : 0);
