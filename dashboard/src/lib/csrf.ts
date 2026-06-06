/**
 * Runtime CSRF / cross-site origin check for the dashboard.
 *
 * Astro 5 enables `security.checkOrigin` by default, but its built-in middleware
 * derives `url.origin` from the build manifest's `allowedDomains`, which is baked
 * in at build time. This dashboard ships as a prebuilt image deployed behind
 * reverse proxies on arbitrary consumer domains, so build-time config cannot
 * apply — Astro reconstructs the origin as `https://localhost` and rejects every
 * proxied form POST. We therefore disable Astro's check (see `astro.config.mjs`)
 * and re-implement the same logic here, sourcing the request host from the
 * proxy's `X-Forwarded-Host` header and adding a runtime env allowlist.
 *
 * This module is pure (Node/web-standard only, no Astro imports) so it can be
 * unit-tested directly and reused from middleware.
 */

/** HTTP methods that never mutate state and so are exempt from the check. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Content types a browser can produce from a plain `<form>` submission without
 * triggering a CORS preflight. Matched case-insensitively via `includes` to
 * mirror Astro's built-in middleware.
 */
const FORM_CONTENT_TYPES = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
];

const ENV_KEY = 'PRAXIS_ALLOWED_ORIGINS';

/** True when `contentType` is one a browser form can send without preflight. */
function isFormContentType(contentType: string): boolean {
  const lowered = contentType.toLowerCase();
  return FORM_CONTENT_TYPES.some((type) => lowered.includes(type));
}

/** The proxied request host: first `x-forwarded-host` value, else `host`. */
function requestHost(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-host');
  const raw = forwarded ? forwarded.split(',')[0] : request.headers.get('host');
  return (raw ?? '').trim().toLowerCase();
}

/** Host of the `Origin` header, falling back to the `Referer` host. */
function sourceHost(request: Request): string | null {
  const candidates = [
    request.headers.get('origin'),
    request.headers.get('referer'),
  ];
  for (const candidate of candidates) {
    if (candidate) {
      try {
        return new URL(candidate).host.toLowerCase();
      } catch {
        // Malformed header — fall through and treat as no usable source.
      }
    }
  }
  return null;
}

/** Parsed, normalised entries from `PRAXIS_ALLOWED_ORIGINS`. */
function allowedHosts(): string[] {
  const raw = process.env[ENV_KEY] ?? '';
  return raw
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (entry.includes('://')) {
        try {
          return new URL(entry).host.toLowerCase();
        } catch {
          return entry;
        }
      }
      return entry;
    });
}

/** True when `host` matches an allowlist entry, honouring `*.` wildcards. */
function isAllowlisted(host: string): boolean {
  return allowedHosts().some((entry) => {
    if (entry.startsWith('*.')) {
      const rest = entry.slice(2);
      return host.endsWith(`.${rest}`);
    }
    return host === entry;
  });
}

/**
 * Returns a 403 `Response` when `request` is a forbidden cross-site form
 * submission, or `null` when it is allowed to proceed.
 */
export function csrfBlock(request: Request): Response | null {
  const method = request.method.toUpperCase();
  if (SAFE_METHODS.has(method)) {
    return null;
  }

  const contentType = request.headers.get('content-type');
  // A non-form content type (e.g. application/json) cannot be produced by a
  // simple cross-site form and is CORS-preflight protected, so it is allowed.
  if (contentType !== null && !isFormContentType(contentType)) {
    return null;
  }

  const origin = sourceHost(request);
  if (origin !== null && (origin === requestHost(request) || isAllowlisted(origin))) {
    return null;
  }

  return new Response(`Cross-site ${method} form submissions are forbidden`, {
    status: 403,
  });
}
