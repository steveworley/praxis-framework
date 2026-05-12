import type { APIRoute } from 'astro';

import { deleteThread, loadThread } from '@/lib/chat/conversation.js';
import { getRoleHome } from '@/lib/role-home.js';

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const id = params['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return json(400, { error: 'Missing thread id' });
  }
  try {
    const detail = await loadThread(getRoleHome(), id);
    return json(200, detail);
  } catch (error: unknown) {
    if (isNotFound(error)) return json(404, { error: 'Thread not found' });
    return json(500, { error: errorMessage(error) });
  }
};

export const DELETE: APIRoute = async ({ params }) => {
  const id = params['id'];
  if (typeof id !== 'string' || id.length === 0) {
    return json(400, { error: 'Missing thread id' });
  }
  try {
    await deleteThread(getRoleHome(), id);
    return json(200, { ok: true });
  } catch (error: unknown) {
    if (isNotFound(error)) return json(404, { error: 'Thread not found' });
    return json(500, { error: errorMessage(error) });
  }
};

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

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
