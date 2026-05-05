import type { APIRoute } from 'astro';

import { assembleActivity } from '@/lib/activity-loader';
import { getLogGlob, getRoleHome, nowIso } from '@/lib/role-home';

export const prerender = false;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

export const GET: APIRoute = async ({ url }) => {
  const roleHome = getRoleHome();
  const logGlob = getLogGlob();
  const rawLimit = url.searchParams.get('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsed)) {
      limit = Math.max(1, Math.min(MAX_LIMIT, parsed));
    }
  }
  try {
    const entries = await assembleActivity(roleHome, logGlob, limit);
    return jsonResponse(200, {
      entries,
      limit,
      updated_at: nowIso(),
    });
  } catch (error: unknown) {
    return jsonResponse(500, { error: errorMessage(error) });
  }
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
