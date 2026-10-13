/**
 * Границы дня магазина.
 *
 * Сервер живёт в той же зоне, что и магазин, а браузер пользователя может быть в
 * любой: аналитика обязана считать дни одинаково для всех. Поэтому день — это
 * календарный день сервера, а не UTC. Раньше границы шли по UTC: продажа в 01:00
 * по Москве попадала в предыдущий день, и «выручка за сегодня» не сходилась с
 * кассой.
 */

const pad = (value: number) => String(value).padStart(2, "0");

/** Дата по календарю сервера: 2026-09-30, а не сдвиг по UTC. */
export function localDateOnly(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

/** Начало дня (00:00:00.000) по времени сервера. */
export function startOfLocalDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 0, 0, 0, 0);
}

/** Конец дня (23:59:59.999) по времени сервера. */
export function endOfLocalDay(date: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, (month ?? 1) - 1, day ?? 1, 23, 59, 59, 999);
}

/**
 * Все календарные дни периода, включая пустые.
 *
 * Дни без операций нужны графику: без них линия «схлопывает» разрыв, и две
 * продажи через неделю выглядят как соседние.
 */
export function enumerateLocalDays(from: string, to: string, limit = 400): string[] {
  const days: string[] = [];
  const cursor = startOfLocalDay(from);
  const last = startOfLocalDay(to);
  while (cursor <= last && days.length < limit) {
    days.push(localDateOnly(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return days;
}

/**
 * Сутки, в которые попал момент, с точностью до дня магазина.
 *
 * Ключ дня нужен для группировки: `createdAt` приходит в UTC, поэтому прямое
 * `toISOString().slice(0, 10)` сдвигало бы ночные операции на день назад.
 */
export function localDayKey(value: Date): string {
  return localDateOnly(value);
}

/** Зона сервера — её показывает интерфейс, чтобы границы дня были понятны. */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
