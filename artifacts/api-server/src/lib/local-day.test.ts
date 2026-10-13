/**
 * Границы дня магазина: проверяются на ночных и вечерних операциях.
 *
 * Ошибка здесь стоит дорого: выручка за день перестаёт сходиться с кассой, а на
 * графике две продажи через неделю выглядят как соседние.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  endOfLocalDay,
  enumerateLocalDays,
  localDateOnly,
  localDayKey,
  startOfLocalDay,
} from "./local-day.ts";

test("ночная операция остаётся в своих сутках", () => {
  const midnight = new Date(2026, 8, 30, 0, 30, 0);
  assert.equal(localDayKey(midnight), "2026-09-30");
  // Так считалось раньше — по UTC, и операция уезжала на день назад.
  assert.notEqual(midnight.toISOString().slice(0, 10), "2026-09-30");
});

test("поздний вечер тоже остаётся в своих сутках", () => {
  const evening = new Date(2026, 8, 30, 23, 30, 0);
  assert.equal(localDayKey(evening), "2026-09-30");
});

test("границы дня покрывают сутки целиком", () => {
  const start = startOfLocalDay("2026-09-30");
  const end = endOfLocalDay("2026-09-30");
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(end.getHours(), 23);
  assert.equal(end.getMinutes(), 59);
  assert.equal(end.getTime() - start.getTime(), 86_399_999);
  assert.ok(startOfLocalDay("2026-09-30") < new Date(2026, 8, 30, 12, 0, 0));
});

test("дни периода перечисляются вместе с пустыми", () => {
  const days = enumerateLocalDays("2026-09-28", "2026-10-01");
  assert.deepEqual(days, ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01"]);
});

test("перечисление дней уважает предел", () => {
  const days = enumerateLocalDays("2026-01-01", "2026-12-31", 10);
  assert.equal(days.length, 10);
  assert.equal(days[9], "2026-01-10");
});

test("дата без времени форматируется без сдвига", () => {
  assert.equal(localDateOnly(new Date(2026, 0, 1, 0, 0, 0)), "2026-01-01");
  assert.equal(localDateOnly(new Date(2026, 11, 31, 23, 59, 59)), "2026-12-31");
});
