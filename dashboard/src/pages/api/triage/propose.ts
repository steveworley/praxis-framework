import type { APIRoute } from 'astro';
import { z } from 'zod';

import { CoauthorValidationError, proposeChange } from '@/lib/coauthor';
import { MissingApiKeyError } from '@/lib/chat/anthropic';
import { getRoleHome } from '@/lib/role-home';
import { TriageNotFoundError, TriageValidationError } from '@/lib/triage';

/**
 * POST /api/triage/propose — model-led proposal drafting for the co-authoring
 * surface. The operator hands us an escalation id (and optionally extra
 * guidance for a re-draft); the model picks 1..N files to change and returns
 * each as a full file + unified diff + rationale.
 *
 * Single-action route (not a REST resource) — there's no proposal entity
 * persisted server-side; each call produces a fresh set of proposals.
 */
export const prerender = false;

const Body = z.object({
  escalation_id: z.string().min(1).max(200),
  hint: z.string().max(4000).optional(),
});

export const POST: APIRoute = async ({ request }) => {
  const ctype = request.headers.get('content-type') ?? '';
  if (!ctype.includes('application/json')) {
    return json(400, { error: 'Expected application/json body' });
  }
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) {
    return json(422, { error: 'Validation failed', issues: parsed.error.issues });
  }

  try {
    const result = await proposeChange(getRoleHome(), parsed.data);
    return json(200, result);
  } catch (error: unknown) {
    if (error instanceof MissingApiKeyError) return json(503, { error: error.message });
    if (error instanceof CoauthorValidationError) return json(400, { error: error.message });
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
