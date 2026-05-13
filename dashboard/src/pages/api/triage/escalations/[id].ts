import type { APIRoute } from 'astro';

import { loadEscalation, TriageNotFoundError, TriageValidationError } from '@/lib/triage';
import { getRoleHome } from '@/lib/role-home';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const id = String(params['id'] ?? '');
  try {
    const detail = await loadEscalation(getRoleHome(), id);
    return json(200, detail);
  } catch (error: unknown) {
    if (error instanceof TriageNotFoundError) return json(404, { error: error.message });
    if (error instanceof TriageValidationError) return json(400, { error: error.message });
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
