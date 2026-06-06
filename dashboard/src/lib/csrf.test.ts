import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { csrfBlock } from './csrf.ts';

const ENV_KEY = 'PRAXIS_ALLOWED_ORIGINS';
let saved: string | undefined;

beforeEach(() => {
  saved = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(() => {
  if (saved === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = saved;
  }
});

function setAllowed(value: string | undefined): void {
  if (value === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = value;
  }
}

interface RequestOptions {
  method?: string;
  origin?: string;
  referer?: string;
  forwardedHost?: string;
  host?: string;
  contentType?: string;
}

function makeRequest(opts: RequestOptions): Request {
  const headers = new Headers();
  if (opts.origin !== undefined) {
    headers.set('origin', opts.origin);
  }
  if (opts.referer !== undefined) {
    headers.set('referer', opts.referer);
  }
  if (opts.forwardedHost !== undefined) {
    headers.set('x-forwarded-host', opts.forwardedHost);
  }
  if (opts.host !== undefined) {
    headers.set('host', opts.host);
  }
  if (opts.contentType !== undefined) {
    headers.set('content-type', opts.contentType);
  }
  return new Request('https://localhost/', {
    method: opts.method ?? 'GET',
    headers,
  });
}

describe('csrfBlock', () => {
  it('allows safe GET requests', () => {
    const request = makeRequest({
      method: 'GET',
      origin: 'https://evil.example',
      host: 'app.example.com',
    });
    expect(csrfBlock(request)).toBeNull();
  });

  it('allows safe HEAD and OPTIONS requests', () => {
    for (const method of ['HEAD', 'OPTIONS']) {
      const request = makeRequest({
        method,
        origin: 'https://evil.example',
        host: 'app.example.com',
      });
      expect(csrfBlock(request)).toBeNull();
    }
  });

  it('allows a same-site form POST via x-forwarded-host', () => {
    const request = makeRequest({
      method: 'POST',
      origin: 'https://app.example.com',
      forwardedHost: 'app.example.com',
      host: 'localhost',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(request)).toBeNull();
  });

  it('allows a same-site form POST via Host when no forwarded host', () => {
    const request = makeRequest({
      method: 'POST',
      origin: 'https://app.example.com',
      host: 'app.example.com',
      contentType: 'multipart/form-data; boundary=x',
    });
    expect(csrfBlock(request)).toBeNull();
  });

  it('blocks a cross-site form POST with 403', async () => {
    const request = makeRequest({
      method: 'POST',
      origin: 'https://evil.example',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    const result = csrfBlock(request);
    expect(result).not.toBeNull();
    expect(result?.status).toBe(403);
    expect(await result?.text()).toBe(
      'Cross-site POST form submissions are forbidden',
    );
  });

  it('blocks a cross-site POST that has no content-type', () => {
    const request = makeRequest({
      method: 'POST',
      origin: 'https://evil.example',
      forwardedHost: 'app.example.com',
    });
    expect(csrfBlock(request)?.status).toBe(403);
  });

  it('allows a cross-site application/json POST (CORS-protected)', () => {
    const request = makeRequest({
      method: 'POST',
      origin: 'https://evil.example',
      forwardedHost: 'app.example.com',
      contentType: 'application/json',
    });
    expect(csrfBlock(request)).toBeNull();
  });

  it('allows a cross-site origin via an exact env allowlist entry', () => {
    setAllowed('trusted.example.com');
    const request = makeRequest({
      method: 'POST',
      origin: 'https://trusted.example.com',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(request)).toBeNull();
  });

  it('allows a subdomain via a wildcard env allowlist entry', () => {
    setAllowed('*.example.com');
    const deep = makeRequest({
      method: 'POST',
      origin: 'https://a.b.example.com',
      forwardedHost: 'app.other.com',
      contentType: 'text/plain',
    });
    expect(csrfBlock(deep)).toBeNull();

    const shallow = makeRequest({
      method: 'POST',
      origin: 'https://foo.example.com',
      forwardedHost: 'app.other.com',
      contentType: 'text/plain',
    });
    expect(csrfBlock(shallow)).toBeNull();
  });

  it('does not let a wildcard match the apex domain', () => {
    setAllowed('*.example.com');
    const request = makeRequest({
      method: 'POST',
      origin: 'https://example.com',
      forwardedHost: 'app.other.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(request)?.status).toBe(403);
  });

  it('allows a cross-site origin via a full-URL env allowlist entry', () => {
    setAllowed('https://trusted.example.com');
    const request = makeRequest({
      method: 'POST',
      origin: 'https://trusted.example.com',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(request)).toBeNull();
  });

  it('blocks a form POST that has neither Origin nor Referer', () => {
    const request = makeRequest({
      method: 'POST',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(request)?.status).toBe(403);
  });

  it('falls back to Referer when Origin is absent', () => {
    const sameSite = makeRequest({
      method: 'POST',
      referer: 'https://app.example.com/some/path',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(sameSite)).toBeNull();

    const crossSite = makeRequest({
      method: 'POST',
      referer: 'https://evil.example/some/path',
      forwardedHost: 'app.example.com',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(crossSite)?.status).toBe(403);
  });

  it('uses the first value of a multi-value x-forwarded-host', () => {
    const request = makeRequest({
      method: 'POST',
      origin: 'https://app.example.com',
      forwardedHost: 'app.example.com, internal.proxy',
      contentType: 'application/x-www-form-urlencoded',
    });
    expect(csrfBlock(request)).toBeNull();
  });
});
