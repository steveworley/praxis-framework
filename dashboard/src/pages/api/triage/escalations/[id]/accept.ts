import type { APIRoute } from 'astro';
import { z } from 'zod';

import { acceptEscalation, TriageNotFoundError, TriageValidationError } from '@/lib/triage';
import { getRoleHome } from '@/lib/role-home';

export const prerender = false;

const Body = z.object({
  operator_note: z.string().trim().min(1).max(2000).optional(),
});

export const POST: APIRoute = async ({ params, request }) => {
  const id = String(params['id'] ?? '');

  let raw: unknown = {};
  // POST without a body is fine — accept is a binary action with optional note.
  const ctype = request.headers.get('content-type') ?? '';
  if (ctype.includes('application/json')) {
    try {
      raw = await request.json();
    } catch {
      return json(400, { error: 'Invalid JSON body' });
    }
  }

  const parsed = Body.safeParse(raw ?? {});
  if (!parsed.success) {
    return json(422, { error: 'Validation failed', issues: parsed.error.issues });
  }

  try {
    const detail = await acceptEscalation(getRoleHome(), id, parsed.data.operator_note);
    return json(200, { ok: true, escalation: detail });
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
