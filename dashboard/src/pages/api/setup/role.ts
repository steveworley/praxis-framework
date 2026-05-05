import path from 'node:path';

import type { APIRoute } from 'astro';
import { z } from 'zod';

import { getRoleHome } from '@/lib/role-home';
import { SeedError, SeedRequestSchema, seedRole } from '@/lib/seed-role';

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const parsed = SeedRequestSchema.safeParse(body);
  if (!parsed.success) {
    return json(422, {
      error: 'Validation failed',
      issues: parsed.error.issues.map((i: z.ZodIssue) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }

  const roleHome = getRoleHome();
  const templateRoot = path.join(roleHome, 'template');

  try {
    const result = await seedRole(parsed.data, { roleHome, templateRoot });
    return json(200, result);
  } catch (error: unknown) {
    if (error instanceof SeedError) {
      return json(error.status, { error: error.message });
    }
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
