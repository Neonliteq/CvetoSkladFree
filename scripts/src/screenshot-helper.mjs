/**
 * Запись снимков экрана для проверок интерфейса.
 *
 * Каталог снимков не хранится в репозитории (он в `.gitignore`), и на чистой копии его
 * просто нет — тогда проверка падала с `ENOENT` на записи снимка, хотя сама проверка
 * проходила. Поэтому каталог создаётся на месте, а не предполагается существующим.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
/** Корень репозитория: снимки складываются в `screenshots/` рядом с ним. */
export const repoRoot = path.resolve(here, "..", "..");

/** Сохраняет снимок в `screenshots/<name>`, создавая каталог при необходимости. */
export function saveScreenshot(name, base64) {
  const target = path.join(repoRoot, "screenshots", name);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(base64, "base64"));
  return target;
}

/**
 * Создаёт каталог снимков и возвращает его путь.
 *
 * Нужен там, где путь к снимку вычисляется заранее и передаётся в запись отдельной
 * переменной: заменить такие вызовы на `saveScreenshot` неудобно, а каталог всё равно
 * должен существовать — на чистой копии репозитория его нет.
 */
export function ensureScreenshotsDir() {
  const dir = path.join(repoRoot, "screenshots");
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Создаём каталог при загрузке помощника: проверки, которые пишут снимок по заранее
// вычисленному пути, иначе падали бы с `ENOENT`, и напоминать им об этом не нужно.
ensureScreenshotsDir();
