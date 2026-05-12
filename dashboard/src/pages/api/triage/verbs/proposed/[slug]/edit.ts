import type { APIRoute } from 'astro';
import { z } from 'zod';

import { editProposedVerb, TriageNotFoundError, TriageValidationError } from '@/lib/triage';
import { getRoleHome } from '@/lib/role-home';

export const prerender = false;

const Body = z.object({
  body: z.string().min(1, 'body is required').max(50_000),
});

export const POST: APIRoute = async ({ params, request }) => {
  const slug = String(params['slug'] ?? '');

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
    const detail = await editProposedVerb(getRoleHome(), slug, parsed.data.body);
    return json(200, { ok: true, verb: detail });
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
