import type { APIRoute } from 'astro';
import { z } from 'zod';

import {
  CoauthorNotFoundError,
  CoauthorValidationError,
  applyChange,
} from '@/lib/coauthor';
import { getRoleHome } from '@/lib/role-home';
import { TriageNotFoundError, TriageValidationError } from '@/lib/triage';

/**
 * POST /api/triage/apply — writes a co-authored change to disk and creates
 * the operator-attributed audit commit. The operator (via the UI) is the
 * only actor that can hit this endpoint; the model's draft is just an
 * editable proposal.
 */
export const prerender = false;

const Body = z.object({
  escalation_id: z.string().min(1).max(200),
  target_path: z.string().min(1).max(300),
  proposed_content: z.string().min(1).max(200_000),
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
    const result = await applyChange(getRoleHome(), parsed.data);
    return json(200, { ok: true, ...result });
  } catch (error: unknown) {
    if (error instanceof CoauthorNotFoundError) return json(404, { error: error.message });
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
