import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `astro:middleware` is a virtual module that only exists inside the Astro
// build pipeline. In the test runner we stub `defineMiddleware` to the
// identity function so the exported `onRequest` is a plain callable.
vi.mock('astro:middleware', () => ({
  defineMiddleware: (fn: unknown) => fn,
}));

import { COOKIE_NAME, expectedToken } from './lib/auth.ts';
import { onRequest } from './middleware.ts';

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

interface MockContextOptions {
  pathname: string;
  search?: string;
  cookieValue?: string | undefined;
  method?: string;
  origin?: string;
  forwardedHost?: string;
  contentType?: string;
  referer?: string;
}

interface MockContext {
  context: Record<string, unknown>;
  next: ReturnType<typeof vi.fn>;
  redirect: ReturnType<typeof vi.fn>;
  locals: { authEnabled?: boolean };
}

function makeContext(opts: MockContextOptions): MockContext {
  const url = new URL(`https://example.test${opts.pathname}${opts.search ?? ''}`);
  const nextResponse = new Response('ok');
  const next = vi.fn(() => nextResponse);
  const redirect = vi.fn((location: string, status?: number) => new Response(null, {
    status: status ?? 302,
    headers: { location },
  }));
  const locals: { authEnabled?: boolean } = {};
  const headers = new Headers();
  if (opts.origin !== undefined) {
    headers.set('origin', opts.origin);
  }
  if (opts.forwardedHost !== undefined) {
    headers.set('x-forwarded-host', opts.forwardedHost);
  }
  if (opts.contentType !== undefined) {
    headers.set('content-type', opts.contentType);
  }
  if (opts.referer !== undefined) {
    headers.set('referer', opts.referer);
  }
  const context = {
    url,
    request: new Request(url.toString(), {
      method: opts.method ?? 'GET',
      headers,
    }),
    locals,
    redirect,
    cookies: {
      get: (name: string) =>
        name === COOKIE_NAME && opts.cookieValue !== undefined
          ? { value: opts.cookieValue }
          : undefined,
    },
  };
  return { context, next, redirect, locals };
}

function invoke(mock: MockContext): unknown {
  return (onRequest as (c: unknown, n: unknown) => unknown)(mock.context, mock.next);
}

describe('onRequest (auth disabled)', () => {
  it('passes through and marks locals.authEnabled false', () => {
    delete process.env[ENV_KEY];
    const mock = makeContext({ pathname: '/chat' });
    invoke(mock);
    expect(mock.next).toHaveBeenCalledOnce();
    expect(mock.locals.authEnabled).toBe(false);
  });

  it('blocks a cross-site form POST with 403 even when auth is disabled', () => {
    delete process.env[ENV_KEY];
    const mock = makeContext({
      pathname: '/api/setup/role',
      method: 'POST',
      origin: 'https://evil.example',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    const result = invoke(mock) as Response;
    expect(result.status).toBe(403);
    expect(mock.next).not.toHaveBeenCalled();
  });

  it('lets a same-site form POST proceed into the auth logic', () => {
    delete process.env[ENV_KEY];
    const mock = makeContext({
      pathname: '/api/setup/role',
      method: 'POST',
      origin: 'https://app.example.com',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    invoke(mock);
    expect(mock.next).toHaveBeenCalledOnce();
    expect(mock.locals.authEnabled).toBe(false);
  });
});

describe('onRequest (auth enabled)', () => {
  beforeEach(() => {
    process.env[ENV_KEY] = 'hunter2';
  });

  it('marks locals.authEnabled true', () => {
    const mock = makeContext({ pathname: '/login' });
    invoke(mock);
    expect(mock.locals.authEnabled).toBe(true);
  });

  it.each(['/login', '/logout', '/_astro/x.css', '/fonts/a.woff2', '/favicon.ico'])(
    'allow-lists %s without a cookie',
    (pathname) => {
      const mock = makeContext({ pathname });
      invoke(mock);
      expect(mock.next).toHaveBeenCalledOnce();
      expect(mock.redirect).not.toHaveBeenCalled();
    },
  );

  it('redirects a page request with no cookie to /login with an encoded next', () => {
    const mock = makeContext({ pathname: '/chat', search: '?tab=x' });
    invoke(mock);
    expect(mock.next).not.toHaveBeenCalled();
    expect(mock.redirect).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent('/chat?tab=x')}`,
      302,
    );
  });

  it('redirects a page request with an invalid cookie to /login', () => {
    const mock = makeContext({ pathname: '/chat', cookieValue: 'bogus' });
    invoke(mock);
    expect(mock.redirect).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent('/chat')}`,
      302,
    );
  });

  it('returns 401 JSON for an api request with no cookie', async () => {
    const mock = makeContext({ pathname: '/api/foo' });
    const result = (await invoke(mock)) as Response;
    expect(mock.next).not.toHaveBeenCalled();
    expect(mock.redirect).not.toHaveBeenCalled();
    expect(result.status).toBe(401);
    expect(result.headers.get('content-type')).toContain('application/json');
    expect(await result.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns 401 JSON for an api request with an invalid cookie', async () => {
    const mock = makeContext({ pathname: '/api/foo', cookieValue: 'bogus' });
    const result = (await invoke(mock)) as Response;
    expect(result.status).toBe(401);
  });

  it('passes through when the cookie holds the expected token', () => {
    const mock = makeContext({ pathname: '/chat', cookieValue: expectedToken() });
    invoke(mock);
    expect(mock.next).toHaveBeenCalledOnce();
    expect(mock.redirect).not.toHaveBeenCalled();
  });
});
