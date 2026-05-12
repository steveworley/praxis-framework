import fs from 'node:fs/promises';
import path from 'node:path';

import { parseFrontmatter } from '../frontmatter.js';
import {
  OUTPUT_TYPE_ENUM,
  OUTPUT_TYPES,
  SLUG_RE,
  STATUS_ENUM,
  type OutputStatus,
  type OutputSummary,
  type OutputType,
} from './types.js';

/**
 * Reader for the `output/` taxonomy on disk. Pure file IO — no commits, no
 * mutations. The chat tools and API routes layer their own write behaviour
 * around the loader's view.
 *
 * Layout the loader expects (created by the seed step + the write tool):
 *
 *   output/
 *     document/<slug>.md
 *     draft/<slug>.md
 *     record/<entity_type>/<entity_id>/<slug>.md
 *     plan/<slug>.md
 *     reference/<slug>.md
 *
 * Files without `type:` frontmatter are skipped (operator-dropped placeholders
 * like `.gitkeep` or README.md never qualify); files whose `type:` disagrees
 * with the directory are also skipped — the directory is the source of truth.
 */

// ---- Errors -------------------------------------------------------------

export class OutputNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputNotFoundError';
  }
}

export class OutputValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputValidationError';
  }
}

// ---- Lister -------------------------------------------------------------

export interface ListOpts {
  type?: OutputType;
  status?: OutputStatus;
  entityType?: string;
  entityId?: string;
  limit?: number;
}

export async function listOutputs(
  roleHome: string,
  opts: ListOpts = {},
): Promise<OutputSummary[]> {
  const types: OutputType[] = opts.type ? [opts.type] : [...OUTPUT_TYPE_ENUM];
  const all: OutputSummary[] = [];

  for (const type of types) {
    const typeRoot = path.join(roleHome, 'output', type);
    if (!(await pathExists(typeRoot))) continue;

    const mdFiles = await walkMarkdown(typeRoot);
    for (const abs of mdFiles) {
      const summary = await readOutputSummary(abs, roleHome, type);
      if (!summary) continue;
      if (opts.status && summary.status !== opts.status) continue;
      if (type === 'record') {
        if (opts.entityType && summary.extras['entity_type'] !== opts.entityType) continue;
        if (opts.entityId && summary.extras['entity_id'] !== opts.entityId) continue;
      }
      all.push(summary);
    }
  }

  all.sort((a, b) => b.updated.localeCompare(a.updated));
  if (opts.limit && opts.limit > 0) {
    return all.slice(0, opts.limit);
  }
  return all;
}

// ---- Loader (detail) ----------------------------------------------------

export interface OutputDetail {
  meta: OutputSummary;
  /** Full frontmatter map (lowercased keys). */
  frontmatter: Record<string, string>;
  body: string;
}

/**
 * Load a single output entry by type + slug. For records, the slug is the
 * combined `entity_type/entity_id/<slug>` path segments — the API route
 * passes through Astro's `[...slug]` rest param.
 *
 * Path traversal is rejected: every segment must match SLUG_RE. Throws
 * `OutputNotFoundError` if the file doesn't exist or its type doesn't
 * match the directory it sits in.
 */
export async function loadOutput(
  roleHome: string,
  type: OutputType,
  slugOrPath: string,
): Promise<OutputDetail> {
  const segments = slugOrPath
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const segment of segments) {
    if (!SLUG_RE.test(segment)) {
      throw new OutputValidationError(
        `Invalid path segment '${segment}': each must match ${SLUG_RE}.`,
      );
    }
  }

  let relPath: string;
  if (type === 'record') {
    if (segments.length !== 3) {
      throw new OutputValidationError(
        `record paths require <entity_type>/<entity_id>/<slug>; got '${slugOrPath}'.`,
      );
    }
    relPath = `output/record/${segments[0]}/${segments[1]}/${segments[2]}.md`;
  } else {
    if (segments.length !== 1) {
      throw new OutputValidationError(
        `${type} paths require a single slug; got '${slugOrPath}'.`,
      );
    }
    relPath = `output/${type}/${segments[0]}.md`;
  }

  const abs = path.join(roleHome, relPath);
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch {
    throw new OutputNotFoundError(`Output not found: ${relPath}`);
  }

  const { frontmatter, body } = parseFrontmatter(text);
  const meta = projectSummary(frontmatter, relPath, type, segments);
  if (!meta) {
    throw new OutputValidationError(
      `Output frontmatter malformed or type mismatch at ${relPath}.`,
    );
  }

  return { meta, frontmatter, body };
}

// ---- Internals: read one + project to summary ---------------------------

async function readOutputSummary(
  abs: string,
  roleHome: string,
  type: OutputType,
): Promise<OutputSummary | null> {
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch {
    return null;
  }
  const { frontmatter } = parseFrontmatter(text);
  const rel = path.relative(roleHome, abs).split(path.sep).join('/');
  const segments = computePathSegments(rel, type);
  if (!segments) return null;
  return projectSummary(frontmatter, rel, type, segments);
}

function computePathSegments(rel: string, type: OutputType): string[] | null {
  // rel is like `output/document/foo.md` or `output/record/account/acme/2026-q1.md`.
  const prefix = `output/${type}/`;
  if (!rel.startsWith(prefix)) return null;
  if (!rel.endsWith('.md')) return null;
  const tail = rel.slice(prefix.length, -3);
  const segments = tail.split('/').filter((s) => s.length > 0);
  if (type === 'record') {
    return segments.length === 3 ? segments : null;
  }
  return segments.length === 1 ? segments : null;
}

function projectSummary(
  fm: Record<string, string>,
  relPath: string,
  type: OutputType,
  segments: string[],
): OutputSummary | null {
  const slug = type === 'record' ? (segments[2] ?? '') : (segments[0] ?? '');
  if (slug.length === 0) return null;
  if (fm['type'] && fm['type'] !== type) return null;

  const status = isStatus(fm['status']) ? fm['status'] : 'draft';
  const created = fm['created'] ?? '';
  const updated = fm['updated'] ?? created;

  const extras: Record<string, string | string[]> = {};
  const spec = OUTPUT_TYPES[type];
  for (const field of [...spec.required, ...spec.optional]) {
    const v = fm[field];
    if (v === undefined) continue;
    if (field === 'tags') {
      extras[field] = parseTags(v);
    } else {
      extras[field] = v;
    }
  }
  if (type === 'record') {
    // Path-derived entity fields override any frontmatter drift (directory
    // is the source of truth for records).
    extras['entity_type'] = segments[0] ?? '';
    extras['entity_id'] = segments[1] ?? '';
  }

  const title = deriveTitle(type, slug, extras);

  return {
    type,
    slug,
    status,
    created,
    updated,
    path: relPath,
    title,
    extras,
  };
}

function deriveTitle(
  type: OutputType,
  slug: string,
  extras: Record<string, string | string[]>,
): string {
  if (type === 'document' && typeof extras['title'] === 'string') return extras['title'];
  if (type === 'draft' && typeof extras['subject'] === 'string') return extras['subject'];
  if (type === 'plan' && typeof extras['goal'] === 'string') return extras['goal'];
  if (type === 'reference' && typeof extras['topic'] === 'string') return extras['topic'];
  if (type === 'record') {
    const et = typeof extras['entity_type'] === 'string' ? extras['entity_type'] : '';
    const eid = typeof extras['entity_id'] === 'string' ? extras['entity_id'] : '';
    if (et && eid) return `${et} · ${eid} · ${slug}`;
  }
  return slug;
}

function isStatus(v: string | undefined): v is OutputStatus {
  if (v === undefined) return false;
  return (STATUS_ENUM as readonly string[]).includes(v);
}

/**
 * Frontmatter tag field arrives either as inline JSON-flow (`[a, b]`) or
 * comma-separated. Both shapes degrade to a string array.
 */
function parseTags(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((t) => stripQuotes(t.trim()))
      .filter((t) => t.length > 0);
  }
  return trimmed
    .split(',')
    .map((t) => stripQuotes(t.trim()))
    .filter((t) => t.length > 0);
}

function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const f = s[0];
  const l = s[s.length - 1];
  if ((f === '"' && l === '"') || (f === "'" && l === "'")) return s.slice(1, -1);
  return s;
}

async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        if (entry.name.toLowerCase() === 'readme.md') continue;
        out.push(full);
      }
    }
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
