/**
 * Проверка, что в репозиторий не попали личные данные.
 *
 * Запускайте перед публикацией или перед тем, как отдать код: скрипт падает, если
 * найдёт в файлах пароли, адреса серверов, домены или личные пути.
 *
 * Список личных строк лежит отдельно — в \`scripts/private-patterns.json\` (образец:
 * \`private-patterns.example.json\`). Держать его в этом файле нельзя: тогда проверка
 * находила бы саму себя. Сам файл со списком в репозиторий не добавляйте.
 *
 * Найденные значения в вывод не печатаются, чтобы проверка не повторяла утечку в логе.
 *
 * Usage: node scripts/src/check-private-data.mjs [каталог]
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(process.argv[2] ?? ".");

/** Читает список личных строк. Каждая запись: { label, pattern }. */
function loadPatterns() {
  const configPath = path.join(root, "scripts", "private-patterns.json");
  let raw;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch {
    console.error(
      `Нет файла со списком личных строк: ${configPath}\n` +
        "Скопируйте scripts/private-patterns.example.json в scripts/private-patterns.json и заполните.",
    );
    process.exit(2);
  }
  const list = JSON.parse(raw);
  if (!Array.isArray(list) || list.length === 0) {
    console.error("Список пуст: заполните scripts/private-patterns.json.");
    process.exit(2);
  }
  return list.map((entry) => ({ label: entry.label, pattern: new RegExp(entry.pattern, "iu") }));
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".vite", "coverage"]);
const SKIP_EXT = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".woff", ".woff2"]);
// Сам список не проверяем: иначе он находит себя и проверка всегда падает. Образец
// списка — тоже: он состоит из заполнителей и по замыслу совпадает с шаблонами.
const SKIP_FILES = new Set(["scripts/private-patterns.json", "scripts/private-patterns.example.json"]);

function walk(dir, relative = "") {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relativePath = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...walk(path.join(dir, entry.name), relativePath));
      continue;
    }
    if (!entry.isFile() || SKIP_EXT.has(path.extname(entry.name).toLowerCase())) continue;
    if (SKIP_FILES.has(relativePath)) continue;
    found.push(relativePath);
  }
  return found;
}

const patterns = loadPatterns();
const files = walk(root);
const hits = [];
for (const file of files) {
  let content;
  try {
    content = readFileSync(path.join(root, file), "utf8");
  } catch {
    continue;
  }
  for (const { label, pattern } of patterns) {
    const match = pattern.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split(/\r?\n/u).length;
    hits.push({ file, line, label });
  }
}

console.log(`Проверено файлов: ${files.length}, шаблонов: ${patterns.length}`);
if (hits.length === 0) {
  console.log("Личных данных не найдено.");
  process.exit(0);
}
console.error(`\nНайдено совпадений: ${hits.length}\n`);
for (const hit of hits) console.error(`  ${hit.file}:${hit.line} — ${hit.label}`);
process.exit(1);
