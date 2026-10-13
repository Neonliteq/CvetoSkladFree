/**
 * Authentication primitives: password hashing, session tokens and the login
 * throttle.
 *
 * Kept free of Express so the rules (expiry, revocation, lockout) are unit
 * testable, and so the same helpers can serve the HTTP API, the bots and the
 * scripts.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";

/** Cost high enough for a three-person shop, fast enough on a small VPS. */
const BCRYPT_ROUNDS = 12;

const SESSION_BYTES = 32;
const DEVICE_BYTES = 32;

export const SESSION_COOKIE = "florasklad_session";
export const DEVICE_COOKIE = "florasklad_device";

/** 30 days: staff should not retype a password every week. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A trusted tablet is re-approved twice a year. */
export const DEVICE_TTL_MS = 180 * 24 * 60 * 60 * 1000;
/** PIN sessions are short: the shop floor is a shared space. */
export const PIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const PIN_LENGTH = 4;
export const PIN_MAX_ATTEMPTS = 5;
export const PIN_LOCK_MS = 15 * 60 * 1000;

export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(password, hash);
  } catch {
    // A malformed hash in the database must never authenticate anybody.
    return false;
  }
}

/** Usernames are compared case-insensitively and without stray spaces. */
export function normalizeUsername(username: string): string {
  return username.trim().toLocaleLowerCase("ru").replace(/\s+/gu, "");
}

export function createToken(bytes = SESSION_BYTES): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison for tokens that are not stored as plain text. */
export function tokensMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_MS);
}

export function deviceExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + DEVICE_TTL_MS);
}

/** Minimum requirements for a password the admin sets for somebody else. */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return "Пароль должен быть не короче 8 символов";
  if (password.length > 200) return "Пароль слишком длинный";
  if (!/[a-zA-Zа-яА-Я]/u.test(password) || !/\d/u.test(password)) {
    return "Пароль должен содержать хотя бы одну букву и одну цифру";
  }
  return null;
}

export function pinProblem(pin: string): string | null {
  if (!new RegExp(`^\\d{${PIN_LENGTH}}$`, "u").test(pin)) {
    return `PIN должен состоять из ${PIN_LENGTH} цифр`;
  }
  if (/^(\d)\1+$/u.test(pin)) return "PIN не должен состоять из одинаковых цифр";
  if (["1234", "12345", "0123", "4321", "1111", "0000"].includes(pin)) {
    return "Слишком простой PIN";
  }
  return null;
}

type ThrottleEntry = { failures: number; firstFailureAt: number; blockedUntil?: number };

/**
 * In-memory login throttle.
 *
 * Deliberately not stored in the database: it guards against online guessing,
 * and a restart clearing it is acceptable. Attempts are counted per key
 * (username + address), so one person's typos do not lock out the shop.
 */
export class LoginThrottle {
  #entries = new Map<string, ThrottleEntry>();

  constructor(
    private readonly maxAttempts = LOGIN_MAX_ATTEMPTS,
    private readonly windowMs = LOGIN_WINDOW_MS,
  ) {}

  /** Milliseconds left before another attempt is allowed, or 0. */
  retryAfterMs(key: string, now = Date.now()): number {
    const entry = this.#entries.get(key);
    if (!entry) return 0;
    if (entry.blockedUntil && entry.blockedUntil > now) {
      return entry.blockedUntil - now;
    }
    if (now - entry.firstFailureAt > this.windowMs) {
      this.#entries.delete(key);
      return 0;
    }
    return 0;
  }

  registerFailure(key: string, now = Date.now()): void {
    const entry = this.#entries.get(key);
    if (!entry || now - entry.firstFailureAt > this.windowMs) {
      this.#entries.set(key, { failures: 1, firstFailureAt: now });
      return;
    }
    entry.failures += 1;
    if (entry.failures >= this.maxAttempts) {
      entry.blockedUntil = now + this.windowMs;
    }
  }

  reset(key: string): void {
    this.#entries.delete(key);
  }
}
