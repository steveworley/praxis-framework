import type { APIRoute } from 'astro';
import { z } from 'zod';

import {
  CoauthorNotFoundError,
  CoauthorValidationError,
  draftChange,
} from '@/lib/coauthor';
import { MissingApiKeyError } from '@/lib/chat/anthropic';
import { getRoleHome } from '@/lib/role-home';
import { TriageNotFoundError, TriageValidationError } from '@/lib/triage';

/**
 * POST /api/triage/draft — drafting endpoint for the co-authoring surface.
 *
 * Body: { escalation_id, target, directive }. Returns the unified diff and
 * the full proposed file content so the operator can review, edit inline, or
 * re-draft before calling /api/triage/apply.
 *
 * Single-action route (not a REST resource) — there's no draft entity persisted
 * server-side; each call produces a fresh proposal.
 */
export const prerender = false;

const Target = z.union([
  z.object({ kind: z.literal('persona') }),
  z.object({ kind: z.literal('claude-md') }),
  z.object({ kind: z.literal('verb'), slug: z.string().min(1).max(80) }),
  z.object({ kind: z.literal('lib'), filename: z.string().min(1).max(120) }),
]);

const Body = z.object({
  escalation_id: z.string().min(1).max(200),
  target: Target,
  directive: z.string().trim().min(1).max(4000),
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
    const result = await draftChange(getRoleHome(), parsed.data);
    return json(200, result);
  } catch (error: unknown) {
    if (error instanceof MissingApiKeyError) return json(503, { error: error.message });
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
