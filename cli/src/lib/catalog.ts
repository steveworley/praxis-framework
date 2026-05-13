import fs from 'node:fs/promises';
import path from 'node:path';

import { resolveTemplatePath } from '@praxis/seed';
import { z } from 'zod';

/**
 * Framework-level catalog of tool capabilities that roles can opt into.
 *
 * Roles declare which capabilities they need per-agent; the runtime maps
 * capabilities to concrete adapters at startup. The CLI's `praxis init`
 * wizard surfaces the optional ones for operator selection.
 */

export const CapabilitySchema = z
  .object({
    description: z.string(),
    transport_options: z.array(z.string()).min(1),
    default_transport: z.string(),
    always_available: z.boolean().optional().default(false),
    default_auth_env: z.string().nullable().optional(),
    docker_image: z.string().optional(),
  })
  // Permissive on unknown fields — schema may grow without breaking older CLIs.
  .passthrough();

export type CapabilityRecord = z.infer<typeof CapabilitySchema>;

export interface Capability {
  /** Catalog key, e.g. "bash" or "mcp:google-workspace". */
  name: string;
  description: string;
  transport_options: string[];
  default_transport: string;
  always_available: boolean;
  default_auth_env?: string | null;
  docker_image?: string;
}

export interface Catalog {
  capabilities: Capability[];
  /** Always-available built-ins (bash, edit, log, ...). */
  builtins(): Capability[];
  /** Capabilities the operator can opt into during `praxis init`. */
  optional(): Capability[];
}

/**
 * Resolve `<template-root>/lib/tools.yaml` by delegating to the seed package's
 * template resolver. The seed package owns template-path resolution: it
 * checks `<package-root>/template/` first (the published-mode layout, where
 * the template ships inside the seed tarball), then walks up looking for a
 * sibling `template/` directory (the dev-monorepo layout). Using its
 * resolver here keeps both packages in lockstep on where the template lives.
 */
function catalogPath(): string {
  return path.join(resolveTemplatePath(), 'lib', 'tools.yaml');
}

/**
 * Load the framework catalog from `template/lib/tools.yaml`. Throws if the
 * file is missing or unparseable — the CLI cannot function without it.
 */
export async function loadCatalog(): Promise<Catalog> {
  const CATALOG_PATH = catalogPath();
  let text: string;
  try {
    text = await fs.readFile(CATALOG_PATH, 'utf-8');
  } catch (e: unknown) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new Error(`praxis catalog not found at ${CATALOG_PATH}: ${cause}`);
  }
  return parseCatalog(text);
}

/** Parse a catalog YAML payload. Exported for tests. */
export function parseCatalog(text: string): Catalog {
  const raw = parseToolsYaml(text);
  const capabilities: Capability[] = [];
  for (const [name, fields] of Object.entries(raw)) {
    const result = CapabilitySchema.safeParse(fields);
    if (!result.success) {
      throw new Error(
        `praxis catalog: invalid entry "${name}" — ${result.error.issues
          .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
          .join('; ')}`,
      );
    }
    const cap: Capability = {
      name,
      description: result.data.description,
      transport_options: result.data.transport_options,
      default_transport: result.data.default_transport,
      always_available: result.data.always_available,
    };
    if (result.data.default_auth_env !== undefined) {
      cap.default_auth_env = result.data.default_auth_env;
    }
    if (result.data.docker_image !== undefined) {
      cap.docker_image = result.data.docker_image;
    }
    capabilities.push(cap);
  }

  if (capabilities.length === 0) {
    throw new Error('praxis catalog: no capabilities defined in tools.yaml');
  }

  return {
    capabilities,
    builtins: () => capabilities.filter((c) => c.always_available),
    optional: () => capabilities.filter((c) => !c.always_available),
  };
}

/**
 * Hand-rolled parser for the tools.yaml schema. Same approach as
 * dashboard/src/lib/autonomy-loader.ts — the schema is shallow enough
 * that pulling in a YAML dependency isn't worth it.
 *
 * Supported shape:
 *   capabilities:
 *     bash:
 *       description: "..."
 *       transport_options: [native]
 *       default_transport: native
 *       always_available: true
 *     mcp:slack:
 *       description: "..."
 *       transport_options: [stdio, sse, url]
 *       ...
 *
 * Returns a record of `{ capabilityName: { fieldKey: parsedValue } }`. Field
 * values are scalars (string | number | boolean | null) or string lists.
 * Unknown YAML constructs are skipped rather than failing — the Zod schema
 * is the source of truth on what's required.
 */
type ParsedField = string | number | boolean | null | string[];

export function parseToolsYaml(text: string): Record<string, Record<string, ParsedField>> {
  const lines = text.split('\n');
  const out: Record<string, Record<string, ParsedField>> = {};

  let i = 0;
  let inCapabilities = false;
  let currentCap: string | null = null;
  let currentCapIndent = 0;
  let fieldIndent: number | null = null;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    // Skip blanks and comments at any depth.
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }

    if (!inCapabilities) {
      if (/^capabilities\s*:\s*$/.test(trimmed)) {
        inCapabilities = true;
      }
      i += 1;
      continue;
    }

    const leading = raw.length - raw.trimStart().length;

    // A new top-level key (zero indent) ends the capabilities block.
    if (leading === 0 && /:\s*$/.test(trimmed)) {
      break;
    }

    // Capability header: `<name>:` at the first indent level under
    // `capabilities:`. The header line has the form `<indent><name>:` (line
    // ends with `:` and nothing after) and the indent is the same as (or
    // first establishes) the capability indent. The name itself may contain
    // colons — `mcp:slack:` is `mcp:slack` followed by the trailing `:`.
    const isHeaderLine = trimmed.endsWith(':') && !trimmed.startsWith('-');
    if (isHeaderLine && (currentCap === null || leading <= currentCapIndent)) {
      const name = trimmed.slice(0, -1).trim();
      if (name.length > 0) {
        currentCap = name;
        currentCapIndent = leading;
        fieldIndent = null;
        out[name] = {};
        i += 1;
        continue;
      }
    }

    // Field under the current capability.
    if (currentCap !== null && leading > currentCapIndent) {
      if (fieldIndent === null) fieldIndent = leading;
      const fieldMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(raw);
      if (fieldMatch) {
        const key = (fieldMatch[1] ?? '').trim();
        const rest = (fieldMatch[2] ?? '').trim();
        out[currentCap]![key] = parseScalar(rest);
      }
      i += 1;
      continue;
    }

    i += 1;
  }

  return out;
}

/**
 * Parse a YAML scalar / inline-list value. Handles:
 *   - empty                → null
 *   - `null` / `~`         → null
 *   - `true` / `false`     → boolean
 *   - `[a, b, c]`          → string[]
 *   - quoted "string"      → string (quotes stripped)
 *   - bare string          → string
 *   - integer literal      → number
 */
function parseScalar(raw: string): ParsedField {
  const value = raw.trim();
  if (value.length === 0) return null;
  if (value === 'null' || value === '~') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;

  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (inner.length === 0) return [];
    return inner.split(',').map((part) => stripQuotes(part.trim()));
  }

  if (/^-?\d+$/.test(value)) {
    const n = Number.parseInt(value, 10);
    if (Number.isFinite(n)) return n;
  }

  return stripQuotes(value);
}

function stripQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
