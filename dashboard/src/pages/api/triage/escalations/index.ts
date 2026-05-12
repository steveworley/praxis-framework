import type { APIRoute } from 'astro';
import { z } from 'zod';

import { listEscalations, type EscalationStatusFilter } from '@/lib/triage';
import { getRoleHome, nowIso } from '@/lib/role-home';

export const prerender = false;

const StatusQuery = z.enum(['open', 'accepted', 'declined', 'resolved', 'all']).optional();

export const GET: APIRoute = async ({ url }) => {
  const statusParam = url.searchParams.get('status');
  const parsed = StatusQuery.safeParse(statusParam ?? undefined);
  if (!parsed.success) {
    return json(422, { error: 'Invalid status filter', issues: parsed.error.issues });
  }
  const status: EscalationStatusFilter = parsed.data ?? 'all';

  try {
    const entries = await listEscalations(getRoleHome(), status);
    return json(200, { entries, count: entries.length, status, updated_at: nowIso() });
  } catch (error: unknown) {
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
