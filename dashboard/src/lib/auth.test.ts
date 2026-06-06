import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  COOKIE_NAME,
  expectedToken,
  HMAC_MESSAGE,
  isAuthEnabled,
  MAX_AGE_SECONDS,
  verifyPassword,
  verifyToken,
} from './auth.ts';

const ENV_KEY = 'DASHBOARD_PASSWORD';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = saved;
  }
});

function setPassword(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
}

describe('constants', () => {
  it('exposes the expected cookie name', () => {
    expect(COOKIE_NAME).toBe('praxis_auth');
  });

  it('exposes a 7-day max age in seconds', () => {
    expect(MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 7);
  });

  it('exposes the HMAC message constant', () => {
    expect(HMAC_MESSAGE).toBe('praxis-dashboard-authed');
  });
});

describe('isAuthEnabled', () => {
  it('is false when the password env var is unset', () => {
    setPassword(undefined);
    expect(isAuthEnabled()).toBe(false);
  });

  it('is false when the password is an empty string', () => {
    setPassword('');
    expect(isAuthEnabled()).toBe(false);
  });

  it('is false when the password is only whitespace', () => {
    setPassword('   ');
    expect(isAuthEnabled()).toBe(false);
  });

  it('is true when the password is a non-empty value', () => {
    setPassword('hunter2');
    expect(isAuthEnabled()).toBe(true);
  });
});

describe('verifyPassword', () => {
  it('returns true for an exact match', () => {
    setPassword('hunter2');
    expect(verifyPassword('hunter2')).toBe(true);
  });

  it('returns false for a mismatch', () => {
    setPassword('hunter2');
    expect(verifyPassword('hunter3')).toBe(false);
  });

  it('returns false for inputs of a different length without throwing', () => {
    setPassword('hunter2');
    expect(verifyPassword('a')).toBe(false);
    expect(verifyPassword('this-is-a-much-longer-input')).toBe(false);
  });

  it('returns false for empty input', () => {
    setPassword('hunter2');
    expect(verifyPassword('')).toBe(false);
  });

  it('returns false when auth is disabled', () => {
    setPassword(undefined);
    expect(verifyPassword('anything')).toBe(false);
  });
});

describe('expectedToken', () => {
  it('is stable for a fixed password', () => {
    setPassword('hunter2');
    expect(expectedToken()).toBe(expectedToken());
  });

  it('differs when the password differs', () => {
    setPassword('hunter2');
    const a = expectedToken();
    setPassword('different');
    const b = expectedToken();
    expect(a).not.toBe(b);
  });

  it('does not throw when auth is disabled', () => {
    setPassword(undefined);
    expect(() => expectedToken()).not.toThrow();
  });
});

describe('verifyToken', () => {
  it('returns true for the expected token', () => {
    setPassword('hunter2');
    expect(verifyToken(expectedToken())).toBe(true);
  });

  it('returns false for a tampered token', () => {
    setPassword('hunter2');
    const token = expectedToken();
    const tampered = `${token.slice(0, -1)}${token.endsWith('0') ? '1' : '0'}`;
    expect(verifyToken(tampered)).toBe(false);
  });

  it('returns false for an empty value', () => {
    setPassword('hunter2');
    expect(verifyToken('')).toBe(false);
  });

  it('returns false for an undefined value', () => {
    setPassword('hunter2');
    expect(verifyToken(undefined)).toBe(false);
  });

  it('rejects a previously-valid token after the password changes', () => {
    setPassword('hunter2');
    const oldToken = expectedToken();
    setPassword('rotated');
    expect(verifyToken(oldToken)).toBe(false);
  });
});
