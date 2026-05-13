import type { APIRoute } from 'astro';
import { z } from 'zod';

import { createThread, listThreads } from '@/lib/chat/conversation.js';
import { getRoleHome } from '@/lib/role-home.js';

export const prerender = false;

const CreateBody = z.object({
  first_message: z.string().trim().min(1, 'first_message is required'),
});

export const GET: APIRoute = async () => {
  try {
    const threads = await listThreads(getRoleHome());
    return json(200, { threads });
  } catch (error: unknown) {
    return json(500, { error: errorMessage(error) });
  }
};

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const parsed = CreateBody.safeParse(body);
  if (!parsed.success) {
    return json(422, { error: 'Validation failed', issues: parsed.error.issues });
  }

  try {
    const result = await createThread(getRoleHome(), parsed.data.first_message);
    return json(201, result);
  } catch (error: unknown) {
    return json(500, { error: errorMessage(error) });
  }
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
