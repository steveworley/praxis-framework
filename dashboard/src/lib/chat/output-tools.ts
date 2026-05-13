import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { commitChange, type CommitResult } from '../audit.js';
import { parseFrontmatter } from '../frontmatter.js';
import {
  ChannelSchema,
  OUTPUT_TYPE_ENUM,
  OUTPUT_TYPES,
  OutputPathError,
  resolveOutputPath,
  StatusSchema,
  fieldsSchemaFor,
  type OutputStatus,
  type OutputType,
} from '../output/types.js';
import { isWriteAllowed } from './autonomy-gate.js';
import { localIsoString } from './time-helpers.js';

/**
 * Chat tools for the output taxonomy. Two of them, mirroring write_memory's
 * shape but specialised for the typed output surface:
 *
 *   - write_output         create a new file under output/<type>/...
 *   - update_output_status flip an existing file's status (e.g. draft → sent)
 *
 * Both refuse cleanly with a model-readable message on every failure path:
 * invalid type, malformed slug, missing required fields, channel-enum
 * violation, path traversal, autonomy-gate rejection, file already exists
 * (for write) / file missing (for update). Successful writes commit through
 * the audit module so the role's git log records the growth.
 */

// ---- Result envelopes ---------------------------------------------------

export interface ToolSuccess {
  ok: true;
  summary: string;
  data: Record<string, unknown>;
}

export interface ToolFailure {
  ok: false;
  error: string;
}

export type ToolResult = ToolSuccess | ToolFailure;

// ---- Input schemas ------------------------------------------------------

const TypeSchema = z.enum(OUTPUT_TYPE_ENUM);

/**
 * `fields` carries the type-specific frontmatter the model supplies. We
 * accept `string | string[]` to support the `tags` field on references; all
 * other fields are scalars.
 */
const FieldsSchema = z.record(
  z.string().min(1),
  z.union([z.string(), z.array(z.string())]),
);

export const WriteOutputInput = z.object({
  type: TypeSchema,
  slug: z.string().trim().min(1).max(120),
  body: z.string().min(1),
  status: StatusSchema.optional(),
  fields: FieldsSchema.optional(),
});
export type WriteOutputArgs = z.infer<typeof WriteOutputInput>;

export const UpdateOutputStatusInput = z.object({
  type: TypeSchema,
  slug: z.string().trim().min(1).max(120),
  status: StatusSchema,
  entity_type: z.string().trim().min(1).max(120).optional(),
  entity_id: z.string().trim().min(1).max(120).optional(),
});
export type UpdateOutputStatusArgs = z.infer<typeof UpdateOutputStatusInput>;

// ---- write_output -------------------------------------------------------

export async function executeWriteOutput(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = WriteOutputInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`write_output input invalid: ${formatZodError(parsed.error)}`);
  }
  const data = parsed.data;
  const type = data.type as OutputType;
  const spec = OUTPUT_TYPES[type];

  // Validate type-specific fields with the per-type schema.
  const fields = data.fields ?? {};
  const fieldsParsed = fieldsSchemaFor(type).safeParse(fields);
  if (!fieldsParsed.success) {
    return fail(
      `write_output: ${type} fields invalid: ${formatZodError(fieldsParsed.error)}`,
    );
  }

  // Resolve target path. For records we need entity_type/entity_id segments
  // from the validated fields.
  let relPath: string;
  try {
    const args = {
      type,
      slug: data.slug,
      entity_type:
        type === 'record' && typeof fields['entity_type'] === 'string'
          ? fields['entity_type']
          : undefined,
      entity_id:
        type === 'record' && typeof fields['entity_id'] === 'string'
          ? fields['entity_id']
          : undefined,
    };
    relPath = resolveOutputPath(args);
  } catch (error: unknown) {
    if (error instanceof OutputPathError) return fail(`write_output: ${error.message}`);
    return fail(`write_output: ${errorMessage(error)}`);
  }

  const gate = await isWriteAllowed(roleHome, relPath);
  if (!gate.allowed) return fail(gate.reason);

  const abs = path.join(roleHome, relPath);
  if (await fileExists(abs)) {
    return fail(
      `write_output: ${relPath} already exists. Output files don't overwrite — pick a different slug or call update_output_status to change the existing file's lifecycle.`,
    );
  }

  const status: OutputStatus = data.status ?? 'draft';
  const isoNow = localIsoString(now);
  const frontmatterFields: Array<[string, string]> = [
    ['type', type],
    ['slug', data.slug],
    ['status', status],
  ];

  // Type-specific fields, in the registry's declared order — required first,
  // then optional. Skip undefined values.
  for (const key of [...spec.required, ...spec.optional]) {
    const value = fields[key];
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      frontmatterFields.push([key, renderInlineList(value)]);
    } else {
      frontmatterFields.push([key, value]);
    }
  }

  frontmatterFields.push(['created', isoNow]);
  frontmatterFields.push(['updated', isoNow]);

  const content =
    renderFrontmatter(frontmatterFields) + `\n\n${data.body.trimEnd()}\n`;

  await atomicWrite(abs, content);

  const success = ok(`wrote ${relPath}`, {
    path: relPath,
    type,
    slug: data.slug,
    status,
  });
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [relPath],
    scope: 'output',
    subject: `write ${type} ${data.slug}`,
  });
  return withAuditCommit(success, commit);
}

// ---- update_output_status -----------------------------------------------

export async function executeUpdateOutputStatus(
  roleHome: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<ToolResult> {
  const parsed = UpdateOutputStatusInput.safeParse(rawInput);
  if (!parsed.success) {
    return fail(
      `update_output_status input invalid: ${formatZodError(parsed.error)}`,
    );
  }
  const data = parsed.data;
  const type = data.type as OutputType;

  let relPath: string;
  try {
    relPath = resolveOutputPath({
      type,
      slug: data.slug,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
    });
  } catch (error: unknown) {
    if (error instanceof OutputPathError) return fail(`update_output_status: ${error.message}`);
    return fail(`update_output_status: ${errorMessage(error)}`);
  }

  const gate = await isWriteAllowed(roleHome, relPath);
  if (!gate.allowed) return fail(gate.reason);

  const abs = path.join(roleHome, relPath);
  let text: string;
  try {
    text = await fs.readFile(abs, 'utf-8');
  } catch {
    return fail(
      `update_output_status: ${relPath} does not exist. Create it first with write_output.`,
    );
  }

  const { frontmatter, body } = parseFrontmatter(text);
  if (Object.keys(frontmatter).length === 0) {
    return fail(
      `update_output_status: ${relPath} has no frontmatter — refusing to retrofit one. Inspect the file by hand.`,
    );
  }

  const isoNow = localIsoString(now);
  const previousStatus = frontmatter['status'] ?? 'draft';
  const updated: Record<string, string> = {
    ...frontmatter,
    status: data.status,
    updated: isoNow,
  };
  // Re-serialise in a stable field order: type, slug, status, then the rest.
  const ordered: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const key of ['type', 'slug', 'status']) {
    if (updated[key] !== undefined) {
      ordered.push([key, updated[key]]);
      seen.add(key);
    }
  }
  // Preserve original field order for the remainder (with `updated` floated
  // to the end so the freshest timestamp sits there).
  const tail: Array<[string, string]> = [];
  for (const [k, v] of Object.entries(updated)) {
    if (seen.has(k) || k === 'updated') continue;
    tail.push([k, v]);
  }
  ordered.push(...tail);
  if (updated['updated'] !== undefined) ordered.push(['updated', updated['updated']]);

  const newContent =
    renderFrontmatter(ordered) +
    (body.startsWith('\n') ? body : `\n${body}`);

  await atomicWrite(abs, newContent);

  const success = ok(
    `${relPath} · ${previousStatus} → ${data.status}`,
    {
      path: relPath,
      type,
      slug: data.slug,
      status: data.status,
      previous_status: previousStatus,
    },
  );
  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [relPath],
    scope: 'output',
    subject: `status ${data.slug}: ${previousStatus} → ${data.status}`,
  });
  return withAuditCommit(success, commit);
}

// ---- Shared helpers -----------------------------------------------------

function ok(summary: string, data: Record<string, unknown>): ToolSuccess {
  return { ok: true, summary, data };
}

function fail(message: string): ToolFailure {
  return { ok: false, error: message };
}

function withAuditCommit(success: ToolSuccess, commit: CommitResult): ToolSuccess {
  const data = { ...success.data };
  let summary = success.summary;
  if (commit.committed && commit.sha) {
    data['commit_sha'] = commit.sha;
    if (commit.shortSha) data['commit_short_sha'] = commit.shortSha;
    summary = `${success.summary} · ${commit.shortSha ?? commit.sha.slice(0, 7)}`;
  } else if (commit.warning) {
    data['commit_warning'] = commit.warning;
    summary = `${success.summary} (${commit.warning})`;
  }
  return { ok: true, summary, data };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('; ');
}

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
  // Inline-flow arrays render as `[a, b]` — leave alone.
  if (value.startsWith('[') && value.endsWith(']')) return value;
  if (/^[\s'"#&*!|>%@`?,\[\]{}-]/.test(value) || /[:#]/.test(value)) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

function renderInlineList(values: string[]): string {
  const parts = values.map((v) => {
    if (/[,\s'"\[\]{}]/.test(v)) {
      return `'${v.replace(/'/g, "''")}'`;
    }
    return v;
  });
  return `[${parts.join(', ')}]`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function atomicWrite(abs: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, content, 'utf-8');
  try {
    await fs.rename(tmp, abs);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

// Re-export schemas for tests / callers that want their own gate.
export { ChannelSchema, StatusSchema };
