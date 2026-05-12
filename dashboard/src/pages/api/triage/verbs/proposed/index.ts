import type { APIRoute } from 'astro';

import { listProposedVerbs } from '@/lib/triage';
import { getRoleHome, nowIso } from '@/lib/role-home';

export const prerender = false;

export const GET: APIRoute = async () => {
  try {
    const entries = await listProposedVerbs(getRoleHome());
    return json(200, { entries, count: entries.length, updated_at: nowIso() });
  } catch (error: unknown) {
    return json(500, { error: errorMessage(error) });
  }
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
