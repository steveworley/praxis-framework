import type { APIRoute } from 'astro';
import { simpleGit } from 'simple-git';
import { z } from 'zod';

import {
  emptyBusinessContext,
  loadBusinessContext,
  writeBusinessContext,
} from '@/lib/role/business-context.js';
import { getRoleHome } from '@/lib/role-home.js';

export const prerender = false;

const PutSchema = z.object({
  version: z.number().int().default(1),
  business_context: z.array(
    z.object({
      key: z.string().trim().min(1),
      label: z.string().trim().min(1),
      value: z.string().default(''),
    }),
  ),
});

export const GET: APIRoute = async () => {
  const roleHome = getRoleHome();
  const bc = await loadBusinessContext(roleHome);
  if (!bc) {
    return json(200, {
      initialised: false,
      business_context: emptyBusinessContext().business_context,
    });
  }
  return json(200, { initialised: true, ...bc });
};

export const PUT: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return json(422, { error: 'Validation failed', issues: parsed.error.issues });
  }

  const roleHome = getRoleHome();
  await writeBusinessContext(roleHome, parsed.data);

  try {
    const git = simpleGit(roleHome);
    await git.add(['lib/business-context.yaml']);
    await git.commit('chore(role): update business context');
  } catch {
    return json(200, { ok: true, committed: false });
  }
  return json(200, { ok: true, committed: true });
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
