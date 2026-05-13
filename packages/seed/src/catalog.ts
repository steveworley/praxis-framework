import fs from 'node:fs/promises';
import path from 'node:path';

import { SeedError } from './types.js';

/**
 * Tools-catalog parsing and writing for the seed package.
 *
 * The framework template ships a single `template/lib/tools.yaml` listing
 * every capability a role can opt into. When seeding a role we don't want to
 * copy the catalog wholesale — the seeded `lib/tools.yaml` should contain
 * only the tools enabled for *this* role: every always-available built-in
 * (bash, edit, log) plus any optional capability the operator selected via
 * the wizard.
 *
 * Parser shape mirrors `cli/src/lib/catalog.ts` so the two packages stay in
 * sync. The seed package can't depend on the CLI (the dashboard imports the
 * seed package and we don't want to drag CLI code in), so the parser is
 * duplicated here. If a third caller appears, lift this into a shared module.
 */

export type CatalogFieldValue = string | number | boolean | null | string[];
export type CatalogEntry = Record<string, CatalogFieldValue>;
export type RawCatalog = Record<string, CatalogEntry>;

/**
 * Parse a `tools.yaml` payload into `{ capabilityName: { fieldKey: value } }`.
 *
 * Supported shape — the same as the framework catalog ships today:
 *
 *   capabilities:
 *     bash:
 *       description: "..."
 *       transport_options: [native]
 *       default_transport: native
 *       always_available: true
 *     mcp:slack:
 *       description: "..."
 *       transport_options: [stdio, sse, url]
 *       default_transport: stdio
 *       default_auth_env: SLACK_MCP_TOKEN
 *       docker_image: praxis/mcp-slack:latest
 *
 * Comments and blank lines are skipped at any depth. Unknown YAML constructs
 * are skipped rather than failing — strict validation is the catalog
 * loader's job (the seed package only needs to filter and re-emit).
 */
export function parseToolsYaml(text: string): RawCatalog {
  const lines = text.split('\n');
  const out: RawCatalog = {};

  let i = 0;
  let inCapabilities = false;
  let currentCap: string | null = null;
  let currentCapIndent = 0;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

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
    // `capabilities:`. Names may contain colons (e.g. `mcp:slack`), so we
    // strip only the trailing `:` separator.
    const isHeaderLine = trimmed.endsWith(':') && !trimmed.startsWith('-');
    if (isHeaderLine && (currentCap === null || leading <= currentCapIndent)) {
      const name = trimmed.slice(0, -1).trim();
      if (name.length > 0) {
        currentCap = name;
        currentCapIndent = leading;
        out[name] = {};
        i += 1;
        continue;
      }
    }

    if (currentCap !== null && leading > currentCapIndent) {
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

function parseScalar(raw: string): CatalogFieldValue {
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

/**
 * Field-emit order for each capability. Matches the order the framework
 * catalog uses today so the seeded file is visually familiar to operators.
 * Fields not in this list (if any future schema additions slip through) are
 * appended in insertion order at the end.
 */
const FIELD_ORDER = [
  'description',
  'transport_options',
  'default_transport',
  'always_available',
  'default_auth_env',
  'docker_image',
] as const;

/**
 * Read the framework catalog and return the entries enabled for a seeded
 * role: every built-in (`always_available: true`) plus any optional
 * capability whose name appears in `selectedTools`. Selected names with no
 * matching catalog entry are silently dropped — the wizard validates against
 * the catalog upstream, so unknown names here are an invariant violation
 * we'd rather not propagate into the seeded file.
 *
 * Throws `SeedError('TEMPLATE_MISSING')` when the template's tools.yaml
 * isn't readable.
 */
export async function buildSeededCatalog(
  templateRoot: string,
  selectedTools: readonly string[],
): Promise<RawCatalog> {
  const catalogPath = path.join(templateRoot, 'lib', 'tools.yaml');
  let text: string;
  try {
    text = await fs.readFile(catalogPath, 'utf-8');
  } catch (e: unknown) {
    const cause = e instanceof Error ? e.message : String(e);
    throw new SeedError(
      `Failed to read template catalog ${catalogPath}: ${cause}`,
      'TEMPLATE_MISSING',
    );
  }

  const full = parseToolsYaml(text);
  const selected = new Set(selectedTools);
  const out: RawCatalog = {};
  for (const [name, entry] of Object.entries(full)) {
    const isBuiltin = entry['always_available'] === true;
    if (isBuiltin || selected.has(name)) {
      out[name] = entry;
    }
  }
  return out;
}

/**
 * Render a filtered catalog back to YAML matching the framework template's
 * shape. Header comment is short — operators read the framework's catalog
 * for the schema; the seeded file is just the activated subset.
 */
export function renderToolsYaml(catalog: RawCatalog): string {
  const lines: string[] = [];
  lines.push('# Tools enabled for this role.');
  lines.push('#');
  lines.push("# Mirrors the framework catalog at <framework>/template/lib/tools.yaml,");
  lines.push('# filtered to the always-available built-ins plus any optional capabilities');
  lines.push("# the operator selected during `praxis init`. To enable another tool, add");
  lines.push('# its entry from the framework catalog here.');
  lines.push('');
  lines.push('capabilities:');

  const names = Object.keys(catalog);
  for (const name of names) {
    const entry = catalog[name] ?? {};
    lines.push(`  ${name}:`);
    const seen = new Set<string>();
    for (const key of FIELD_ORDER) {
      if (key in entry) {
        seen.add(key);
        lines.push(`    ${key}: ${formatYamlValue(entry[key] as CatalogFieldValue)}`);
      }
    }
    // Trail with any fields not in the canonical order.
    for (const [key, value] of Object.entries(entry)) {
      if (seen.has(key)) continue;
      lines.push(`    ${key}: ${formatYamlValue(value)}`);
    }
    lines.push('');
  }

  // Trim the trailing blank line so file ends with one newline.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return `${lines.join('\n')}\n`;
}

function formatYamlValue(value: CatalogFieldValue): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[${value.map((v) => formatYamlScalar(v)).join(', ')}]`;
  }
  return formatYamlScalar(value);
}

/**
 * Quote a string scalar when bare emission would change its meaning to a
 * parser: reserved literals (`true` / `false` / `null` / `~`), integer-shaped
 * values, leading/trailing whitespace, or characters that introduce YAML
 * structure (`#`, `{`, `[`, `,`, `&`, `*`, `!`, `|`, `>`, `'`, `"`, `%`, `@`,
 * backtick) at the start of the value. Mid-value `:` and `/` are safe in
 * block scalars and would force every docker-image string to be quoted, so
 * we leave those bare to match the framework catalog's existing style.
 */
function formatYamlScalar(value: string): string {
  if (value.length === 0) return '""';
  const first = value[0] ?? '';
  if (
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    value === '~' ||
    /^-?\d+$/.test(value) ||
    value !== value.trim() ||
    '#{}[],&*!|>\'"%@`'.includes(first)
  ) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return value;
}
