import type { APIRoute } from 'astro';

import { parsePersona } from '@/lib/persona-parser';
import { getRoleHome, nowIso } from '@/lib/role-home';

export const prerender = false;

export const GET: APIRoute = async () => {
  const roleHome = getRoleHome();
  try {
    const persona = await parsePersona(roleHome);
    return jsonResponse(200, {
      persona,
      role_home: roleHome,
      updated_at: nowIso(),
    });
  } catch (error: unknown) {
    return jsonResponse(500, { error: errorMessage(error) });
  }
};

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  return String(e);
}
