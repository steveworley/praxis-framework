import type { APIRoute } from 'astro';
import { z } from 'zod';

import { listOutputs } from '@/lib/output/loader';
import { OUTPUT_TYPE_ENUM, STATUS_ENUM } from '@/lib/output/types';
import { getRoleHome, nowIso } from '@/lib/role-home';

export const prerender = false;

/**
 * GET /api/output — list output entries filtered by query params.
 *
 * Query params (all optional):
 *   - type:        document | draft | record | plan | reference
 *   - status:      one of the status enum values
 *   - entity_type: slug-shaped (records only)
 *   - entity_id:   slug-shaped (records only)
 *   - limit:       1..500
 */

const Query = z.object({
  type: z.enum(OUTPUT_TYPE_ENUM).optional(),
  status: z.enum(STATUS_ENUM).optional(),
  entity_type: z.string().trim().min(1).max(120).optional(),
  entity_id: z.string().trim().min(1).max(120).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const GET: APIRoute = async ({ url }) => {
  const raw: Record<string, string> = {};
  for (const [k, v] of url.searchParams) raw[k] = v;
  const parsed = Query.safeParse(raw);
  if (!parsed.success) {
    return json(422, { error: 'Invalid query', issues: parsed.error.issues });
  }
  try {
    const opts: Parameters<typeof listOutputs>[1] = {};
    if (parsed.data.type) opts.type = parsed.data.type;
    if (parsed.data.status) opts.status = parsed.data.status;
    if (parsed.data.entity_type) opts.entityType = parsed.data.entity_type;
    if (parsed.data.entity_id) opts.entityId = parsed.data.entity_id;
    if (parsed.data.limit !== undefined) opts.limit = parsed.data.limit;
    const entries = await listOutputs(getRoleHome(), opts);
    return json(200, { entries, count: entries.length, updated_at: nowIso() });
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
