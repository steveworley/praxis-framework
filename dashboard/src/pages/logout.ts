import type { APIRoute } from 'astro';

import { COOKIE_NAME } from '@/lib/auth';

export const prerender = false;

/**
 * Clears the session cookie and bounces back to the login page. The gate's
 * allow-list lets this route through without an existing valid cookie.
 */
export const GET: APIRoute = ({ cookies, redirect }) => {
  cookies.delete(COOKIE_NAME, { path: '/' });
  return redirect('/login', 302);
};
