import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { APIRoute } from 'astro';
import { z } from 'zod';

import { commitChange } from '@/lib/audit';
import { parseFrontmatter } from '@/lib/frontmatter';
import { renderMarkdown } from '@/lib/markdown';
import {
  OutputNotFoundError,
  OutputValidationError,
  loadOutput,
} from '@/lib/output/loader';
import {
  OUTPUT_TYPE_ENUM,
  STATUS_ENUM,
  type OutputStatus,
  type OutputType,
} from '@/lib/output/types';
import { getRoleHome } from '@/lib/role-home';

export const prerender = false;

/**
 * GET  /api/output/[type]/[...slug]            → load one output entry
 * POST /api/output/[type]/[...slug]            → update its status (operator)
 *
 * For non-record types, slug is a single segment. For records, slug is a
 * multi-segment path: `<entity_type>/<entity_id>/<slug>`. Astro's rest
 * param hands the whole tail to us; we delegate path validation to the
 * loader.
 *
 * The status mutation is an operator-attributed audit commit. The chat
 * tool `update_output_status` does the same work for the role; this
 * endpoint is what the dashboard's "Mark as sent" / "Mark as done"
 * controls hit.
 */

export const GET: APIRoute = async ({ params }) => {
  const typeParam = String(params['type'] ?? '');
  const slugParam = String(params['slug'] ?? '');
  if (!isOutputType(typeParam)) {
    return json(400, { error: `Invalid type: ${typeParam}` });
  }
  try {
    const detail = await loadOutput(getRoleHome(), typeParam, slugParam);
    return json(200, {
      meta: detail.meta,
      body: detail.body,
      body_html: renderMarkdown(detail.body),
      frontmatter: detail.frontmatter,
    });
  } catch (error: unknown) {
    if (error instanceof OutputNotFoundError) return json(404, { error: error.message });
    if (error instanceof OutputValidationError) return json(400, { error: error.message });
    return json(500, { error: errorMessage(error) });
  }
};

const PostBody = z.object({
  status: z.enum(STATUS_ENUM),
});

export const POST: APIRoute = async ({ params, request }) => {
  const typeParam = String(params['type'] ?? '');
  const slugParam = String(params['slug'] ?? '');
  if (!isOutputType(typeParam)) {
    return json(400, { error: `Invalid type: ${typeParam}` });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }
  const parsed = PostBody.safeParse(raw);
  if (!parsed.success) {
    return json(422, { error: 'Validation failed', issues: parsed.error.issues });
  }
  const newStatus: OutputStatus = parsed.data.status;

  const roleHome = getRoleHome();
  try {
    const detail = await loadOutput(roleHome, typeParam, slugParam);
    const relPath = detail.meta.path;
    const abs = path.join(roleHome, relPath);
    const text = await fs.readFile(abs, 'utf-8');
    const { frontmatter, body } = parseFrontmatter(text);
    const previousStatus = frontmatter['status'] ?? 'draft';

    const isoNow = localIsoString(new Date());
    const updated: Record<string, string> = {
      ...frontmatter,
      status: newStatus,
      updated: isoNow,
    };

    const ordered: Array<[string, string]> = [];
    const seen = new Set<string>();
    for (const key of ['type', 'slug', 'status']) {
      if (updated[key] !== undefined) {
        ordered.push([key, updated[key]]);
        seen.add(key);
      }
    }
    const tail: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(updated)) {
      if (seen.has(k) || k === 'updated') continue;
      tail.push([k, v]);
    }
    ordered.push(...tail);
    if (updated['updated'] !== undefined) ordered.push(['updated', updated['updated']]);

    const newContent =
      renderFrontmatter(ordered) + (body.startsWith('\n') ? body : `\n${body}`);
    await atomicWrite(abs, newContent);

    const commit = await commitChange({
      roleHome,
      actor: 'operator',
      filePaths: [relPath],
      scope: 'output',
      subject: `status ${detail.meta.slug}: ${previousStatus} → ${newStatus}`,
    });

    const refreshed = await loadOutput(roleHome, typeParam, slugParam);
    const responseBody: Record<string, unknown> = {
      ok: true,
      meta: refreshed.meta,
      body: refreshed.body,
      body_html: renderMarkdown(refreshed.body),
      previous_status: previousStatus,
    };
    if (commit.committed && commit.sha) responseBody['commit_sha'] = commit.sha;
    if (commit.warning) responseBody['commit_warning'] = commit.warning;
    return json(200, responseBody);
  } catch (error: unknown) {
    if (error instanceof OutputNotFoundError) return json(404, { error: error.message });
    if (error instanceof OutputValidationError) return json(400, { error: error.message });
    return json(500, { error: errorMessage(error) });
  }
};

function renderFrontmatter(fields: Array<[string, string]>): string {
  const lines = ['---'];
  for (const [k, v] of fields) {
    lines.push(`${k}: ${quoteIfNeeded(v)}`);
  }
  lines.push('---');
  return lines.join('\n');
}

function quoteIfNeeded(value: string): string {
  if (value.length === 0) return "''";
  if (value.startsWith('[') && value.endsWith(']')) return value;
  if (/^[\s'"#&*!|>%@`?,\[\]{}-]/.test(value) || /[:#]/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

function localIsoString(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absOffset = Math.abs(offsetMinutes);
  const offHh = String(Math.floor(absOffset / 60)).padStart(2, '0');
  const offMm = String(absOffset % 60).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}${sign}${offHh}:${offMm}`;
}

function isOutputType(v: string): v is OutputType {
  return (OUTPUT_TYPE_ENUM as readonly string[]).includes(v);
}

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
