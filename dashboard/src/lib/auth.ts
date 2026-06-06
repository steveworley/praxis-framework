import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

/**
 * Environment-variable password gate for the dashboard.
 *
 * One env var drives everything: `DASHBOARD_PASSWORD`. When it is unset or
 * empty (after trimming) the gate is disabled and the app is fully open —
 * local dev is unaffected. When set, the gate is active.
 *
 * The session cookie carries a password-derived token rather than a separate
 * secret: `HMAC-SHA256(key = password, message = HMAC_MESSAGE)` hex-encoded.
 * Because the token is derived from the password, rotating the password
 * invalidates every existing session automatically — no second secret to
 * manage.
 *
 * This module is pure (Node `crypto` only, no Astro imports) so it can be
 * unit-tested directly and reused from both middleware and pages.
 */

/** Name of the session cookie that holds the derived auth token. */
export const COOKIE_NAME = 'praxis_auth';

/** Cookie lifetime: 7 days, in seconds. */
export const MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Fixed message HMAC'd with the password to derive the session token. */
export const HMAC_MESSAGE = 'praxis-dashboard-authed';

const ENV_KEY = 'DASHBOARD_PASSWORD';

/** Returns the configured password trimmed, or '' when unset/blank. */
function configuredPassword(): string {
  return (process.env[ENV_KEY] ?? '').trim();
}

/** True when a non-empty `DASHBOARD_PASSWORD` is configured (after trim). */
export function isAuthEnabled(): boolean {
  return configuredPassword().length > 0;
}

/**
 * Constant-time comparison of two strings that tolerates unequal lengths
 * without throwing and without leaking length: both sides are reduced to a
 * fixed-length SHA-256 digest before `timingSafeEqual`.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Constant-time compare of `input` against the configured password. Returns
 * false when auth is disabled or `input` is empty.
 */
export function verifyPassword(input: string): boolean {
  if (!isAuthEnabled() || input.length === 0) {
    return false;
  }
  return constantTimeEquals(input, configuredPassword());
}

/**
 * The expected session token for the configured password. Total and
 * non-throwing: when no password is configured it HMACs the empty key, which
 * is harmless because all callers guard with `isAuthEnabled`/`verifyToken`.
 */
export function expectedToken(): string {
  return createHmac('sha256', configuredPassword()).update(HMAC_MESSAGE).digest('hex');
}

/**
 * Constant-time compare of a cookie value against `expectedToken()`. Returns
 * false for undefined, empty, or mismatched values.
 */
export function verifyToken(cookieValue: string | undefined): boolean {
  if (cookieValue === undefined || cookieValue.length === 0) {
    return false;
  }
  return constantTimeEquals(cookieValue, expectedToken());
}
