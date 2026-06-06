import { defineMiddleware } from 'astro:middleware';

import { COOKIE_NAME, isAuthEnabled, verifyToken } from '@/lib/auth';
import { csrfBlock } from '@/lib/csrf';

/**
 * Request gate for the password-protected dashboard.
 *
 * When `DASHBOARD_PASSWORD` is unset the gate is disabled and every request
 * passes through untouched (local dev stays open). When set, requests must
 * carry a valid `praxis_auth` cookie except for the login/logout flow and
 * static assets. Page requests redirect to `/login`; `/api/*` requests get a
 * JSON 401 so client callers can react without following a redirect.
 *
 * `context.locals.authEnabled` is set on every request so UI (e.g. the logout
 * link in the brand strip) can render conditionally.
 */

const ALLOWED_PREFIXES = ['/_astro', '/fonts', '/favicon'];
const ALLOWED_EXACT = ['/login', '/logout'];

function isAllowListed(pathname: string): boolean {
  if (ALLOWED_EXACT.includes(pathname)) {
    return true;
  }
  return ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export const onRequest = defineMiddleware((context, next) => {
  // Runtime CSRF/origin check runs before the auth gate so it protects
  // unauthenticated POSTs (login, first-run setup wizard) even when no
  // DASHBOARD_PASSWORD is configured.
  const blocked = csrfBlock(context.request);
  if (blocked) {
    return blocked;
  }

  if (!isAuthEnabled()) {
    context.locals.authEnabled = false;
    return next();
  }

  context.locals.authEnabled = true;

  const { pathname, search } = context.url;
  if (isAllowListed(pathname)) {
    return next();
  }

  const token = context.cookies.get(COOKIE_NAME)?.value;
  if (verifyToken(token)) {
    return next();
  }

  if (pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    });
  }

  return context.redirect(`/login?next=${encodeURIComponent(pathname + search)}`, 302);
});
