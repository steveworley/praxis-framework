import type { APIRoute } from 'astro';
import { z } from 'zod';

import { OrganisationSchema, RoleDefinitionSchema } from '@/lib/seed-role';
import { getResearchEngine, type ResearchContext } from '@/lib/research-engine';
import { getRoleHome } from '@/lib/role-home';

export const prerender = false;

export const ResearchRequestSchema = z.object({
  organisation: OrganisationSchema,
  role_definition: RoleDefinitionSchema,
});

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const parsed = ResearchRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(422, {
      error: 'Validation failed',
      issues: parsed.error.issues.map((i: z.ZodIssue) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  const ctx: ResearchContext = parsed.data;
  const engine = getResearchEngine();
  try {
    const result = await engine.propose(ctx, { roleHome: getRoleHome() });
    return json(200, result);
  } catch (error: unknown) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return json(500, { error: message });
  }
};

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
