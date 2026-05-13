import fs from 'node:fs/promises';
import path from 'node:path';

import { simpleGit } from 'simple-git';

export type AutonomyMode = 'full' | 'append-only' | 'inline-enrichment' | 'bounded' | 'gated';

const KNOWN_MODES: ReadonlySet<AutonomyMode> = new Set<AutonomyMode>([
  'full',
  'append-only',
  'inline-enrichment',
  'bounded',
  'gated',
]);

/**
 * A numeric bound for a `bounded`-mode parameter. `min` and `max` are
 * required; `step` is optional — when declared, values must be a multiple of
 * `step` starting from `min` (with a small floating-point tolerance).
 */
export interface Bound {
  min: number;
  max: number;
  step?: number;
}

export interface AutonomySurface {
  /** Path under the role home — directory (`memory/`) or file (`lib/foo.yaml`). */
  path: string;
  /** Mode the operator opened the surface in. Unknown values fall back to `gated`. */
  mode: AutonomyMode;
  /** Operator's note on why this surface is open. May be multi-line. */
  why?: string;
  /** Append-only ceiling before the role must escalate for compaction. */
  max_pending?: number;
  /**
   * For `append-only` YAML surfaces: the top-level key whose list the role
   * may append to (e.g. `strategies` in `lib/research-strategies.yaml`). The
   * append tool refuses if this is absent on an append-only surface.
   */
  root_key?: string;
  /**
   * For `append-only` surfaces: the field on each entry whose value must be
   * unique across the list. Used to detect duplicate appends.
   *
   * For `inline-enrichment` surfaces: identifies which existing entry the
   * role wants to update. Required when mode is `inline-enrichment`.
   */
  unique_by?: string;
  /**
   * For `inline-enrichment` surfaces: which fields within each entry the role
   * may update. All other fields are hard. Required when mode is
   * `inline-enrichment` — the framework refuses the call otherwise.
   */
  soft_fields?: string[];
  /**
   * For `bounded` surfaces: per-parameter numeric ranges the role may adjust
   * within. Required when mode is `bounded`. Parameters absent from this map
   * are NOT adjustable — operator-only.
   */
  bounds?: Record<string, Bound>;
}

export interface AutonomyConfig {
  surfaces: AutonomySurface[];
  /**
   * Per-server MCP allow/deny map. Keys are MCP server names as they appear in
   * `PRAXIS_MCPS` (the prefix in tool names like `slack__post_message`). A
   * server not listed here is **denied by default** — operators must opt in
   * explicitly per server. See `isMcpAllowed` in `chat/autonomy-gate.ts`.
   */
  mcps?: Record<string, 'allow' | 'deny'>;
}

export interface AutonomousEdit {
  sha: string;
  short_sha: string;
  /** ISO timestamp of the commit (author date). */
  date: string;
  author_name: string;
  author_email: string;
  /** First line of the commit subject. */
  message: string;
  /** Paths changed in the commit, relative to the role home. */
  files: string[];
}

export interface RecentAutonomousEditsOptions {
  role_email?: string;
  role_name?: string;
  limit?: number;
  since_days?: number;
  /** If provided, only return commits touching at least one of these paths. */
  autonomous_paths?: string[];
}

const DEFAULT_LIMIT = 20;
const DEFAULT_SINCE_DAYS = 30;

/**
 * Parse `lib/autonomy.yaml` into a typed structure. Returns `null` when the
 * file doesn't exist — that's the normal "no surfaces opened yet" state.
 *
 * The schema is shallow enough that a hand-rolled parser is sufficient: a
 * top-level `surfaces:` list of entries, each with a `path:`, `mode:`,
 * optional `why:` (block scalar `|` allowed), and optional `max_pending:`.
 * Anything that isn't a recognised mode is mapped to `gated` (safe default).
 */
export async function loadAutonomy(roleHome: string): Promise<AutonomyConfig | null> {
  const yamlPath = path.join(roleHome, 'lib', 'autonomy.yaml');
  let text: string;
  try {
    text = await fs.readFile(yamlPath, 'utf-8');
  } catch {
    return null;
  }
  const config: AutonomyConfig = { surfaces: parseAutonomyYaml(text) };
  const mcps = parseMcpsBlock(text);
  if (mcps) config.mcps = mcps;
  return config;
}

/**
 * Pull the top-level `mcps:` block out of `autonomy.yaml`. Shape:
 *
 *   mcps:
 *     slack: allow
 *     gmail: allow
 *     playwright: deny
 *
 * Returns `null` when the section is absent or empty. Values that aren't
 * `allow` or `deny` are dropped (default-deny applies at the call site).
 */
export function parseMcpsBlock(text: string): Record<string, 'allow' | 'deny'> | null {
  const lines = text.split('\n');
  let i = 0;
  let inBlock = false;
  let blockIndent = -1;
  const out: Record<string, 'allow' | 'deny'> = {};

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    if (!inBlock) {
      if (/^mcps\s*:\s*$/.test(trimmed) && raw.length - raw.trimStart().length === 0) {
        inBlock = true;
        blockIndent = 0;
      }
      i += 1;
      continue;
    }

    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }
    const leading = raw.length - raw.trimStart().length;
    if (leading <= blockIndent) {
      // Next top-level key — block ends.
      break;
    }
    const match = /^([A-Za-z_][\w:.-]*)\s*:\s*(.+?)\s*$/.exec(trimmed);
    if (match) {
      const key = (match[1] ?? '').trim();
      const value = stripQuotes((match[2] ?? '').trim());
      if (value === 'allow' || value === 'deny') {
        out[key] = value;
      }
    }
    i += 1;
  }

  if (Object.keys(out).length === 0) return null;
  return out;
}

/**
 * Hand-rolled parser for the autonomy schema. Exported for testing.
 *
 * Supported shapes:
 *   surfaces:
 *     - path: memory/
 *       mode: full
 *       why: |
 *         multi-line
 *         block scalar
 *       max_pending: 5
 *
 * Comment lines (leading `#`) and blank lines outside block scalars are
 * ignored. Quoted scalar values have their surrounding quotes stripped.
 */
export function parseAutonomyYaml(text: string): AutonomySurface[] {
  const lines = text.split('\n');
  const surfaces: AutonomySurface[] = [];

  let i = 0;
  let inSurfaces = false;

  while (i < lines.length) {
    const raw = lines[i] ?? '';
    const trimmed = raw.trim();

    if (!inSurfaces) {
      if (/^surfaces\s*:\s*$/.test(trimmed)) {
        inSurfaces = true;
      }
      i += 1;
      continue;
    }

    // We're inside the surfaces list. Skip blank/comment lines.
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      i += 1;
      continue;
    }

    // A new top-level key (no leading whitespace, ends with ":") ends the list.
    if (!/^\s/.test(raw) && /:\s*$/.test(trimmed) && !trimmed.startsWith('-')) {
      break;
    }

    // Each entry begins with `- key:` (typically `- path:`). Determine the
    // entry's indent + the dash position, then consume continuation lines.
    const dashMatch = /^(\s*)-\s+(.*)$/.exec(raw);
    if (!dashMatch) {
      i += 1;
      continue;
    }
    const entryIndent = dashMatch[1]?.length ?? 0;
    const firstFieldLine = dashMatch[2] ?? '';

    const entryLines: string[] = [firstFieldLine];
    i += 1;
    while (i < lines.length) {
      const next = lines[i] ?? '';
      const nextTrim = next.trim();
      if (nextTrim.length === 0) {
        entryLines.push(next);
        i += 1;
        continue;
      }
      if (nextTrim.startsWith('#')) {
        i += 1;
        continue;
      }
      const leading = next.length - next.trimStart().length;
      if (leading <= entryIndent) {
        // Either a sibling list entry (`-` at same indent) or end of list.
        break;
      }
      entryLines.push(next);
      i += 1;
    }

    const surface = parseEntry(entryLines);
    if (surface) surfaces.push(surface);
  }

  return surfaces;
}

/**
 * Parse a single list-entry block. The first line has had its leading
 * `- ` stripped, so it starts at column 0; subsequent lines retain their
 * original indentation (relative to the file).
 */
function parseEntry(lines: string[]): AutonomySurface | null {
  // Normalise: re-indent the first line so all lines share the same indent
  // basis. The first line's "indent" is whatever was after `- `, which is
  // typically 0; subsequent lines were indented further.
  const fields: Record<string, string> = {};
  const listFields: Record<string, string[]> = {};
  /**
   * Nested mappings whose immediate children are themselves mappings —
   * currently used for `bounds: { <param>: { min, max, step? } }`. Each
   * child key maps to a small string→string map representing the inline
   * scalars of that sub-entry. Values are stripped of quotes; numbers stay
   * as strings here and are coerced in the typed-surface assembly below.
   */
  const mapFields: Record<string, Record<string, Record<string, string>>> = {};

  let idx = 0;
  while (idx < lines.length) {
    const line = lines[idx] ?? '';
    if (line.trim().length === 0) {
      idx += 1;
      continue;
    }

    // Match `key: value` or `key: |` (block scalar marker).
    const fieldMatch = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(line);
    if (!fieldMatch) {
      idx += 1;
      continue;
    }
    const fieldIndent = fieldMatch[1]?.length ?? 0;
    const key = (fieldMatch[2] ?? '').trim();
    const rest = (fieldMatch[3] ?? '').trim();

    if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-') {
      // Block scalar. Consume subsequent lines that are more indented than
      // `fieldIndent`. Preserve relative indentation by stripping the common
      // leading whitespace.
      idx += 1;
      const blockLines: string[] = [];
      let blockIndent: number | null = null;
      while (idx < lines.length) {
        const blockLine = lines[idx] ?? '';
        if (blockLine.trim().length === 0) {
          blockLines.push('');
          idx += 1;
          continue;
        }
        const leading = blockLine.length - blockLine.trimStart().length;
        if (leading <= fieldIndent) break;
        if (blockIndent === null) blockIndent = leading;
        const stripWidth = Math.min(blockIndent, leading);
        blockLines.push(blockLine.slice(stripWidth));
        idx += 1;
      }
      // Trim trailing blank lines for a tidy value.
      while (blockLines.length > 0 && blockLines[blockLines.length - 1] === '') {
        blockLines.pop();
      }
      fields[key] = blockLines.join('\n');
      continue;
    }

    if (rest.length === 0) {
      // Empty value — peek the next non-blank line. Three possibilities:
      //   1. `- item` list items (block sequence)
      //   2. `child: …` mapping entries (block mapping)
      //   3. nothing indented past the key (empty scalar)
      // Look ahead to distinguish (1) vs (2) before consuming anything.
      let probe = idx + 1;
      let firstSignificant: { idx: number; isDash: boolean; isMapping: boolean } | null = null;
      while (probe < lines.length) {
        const peek = lines[probe] ?? '';
        const peekTrim = peek.trim();
        if (peekTrim.length === 0) {
          probe += 1;
          continue;
        }
        const peekLeading = peek.length - peek.trimStart().length;
        if (peekLeading <= fieldIndent) break;
        firstSignificant = {
          idx: probe,
          isDash: /^\s*-\s+/.test(peek),
          isMapping: /^\s*[A-Za-z_][A-Za-z0-9_]*\s*:/.test(peek),
        };
        break;
      }

      if (firstSignificant && firstSignificant.isDash) {
        // Block sequence: gather `- item` lines.
        let cursor = idx + 1;
        const items: string[] = [];
        while (cursor < lines.length) {
          const peek = lines[cursor] ?? '';
          const peekTrim = peek.trim();
          if (peekTrim.length === 0) {
            cursor += 1;
            continue;
          }
          const peekLeading = peek.length - peek.trimStart().length;
          if (peekLeading <= fieldIndent) break;
          const dashMatch = /^\s*-\s+(.*)$/.exec(peek);
          if (!dashMatch) break;
          const item = stripQuotes((dashMatch[1] ?? '').trim());
          if (item.length > 0) items.push(item);
          cursor += 1;
        }
        listFields[key] = items;
        idx = cursor;
        continue;
      }

      if (firstSignificant && firstSignificant.isMapping) {
        // Block mapping: each child line is `<child>: <rest>`. If `<rest>` is
        // inline-flow `{a: 1, b: 2}`, parse it as the child's own scalar map.
        // Otherwise the child has a nested block-mapping body that we walk
        // line-by-line to gather its scalar fields. This handles both
        // `bounds:` shapes the spec calls out.
        const childIndent = firstSignificant.idx < lines.length
          ? (lines[firstSignificant.idx] ?? '').length -
            (lines[firstSignificant.idx] ?? '').trimStart().length
          : fieldIndent + 2;
        const children: Record<string, Record<string, string>> = {};
        let cursor = idx + 1;
        while (cursor < lines.length) {
          const peek = lines[cursor] ?? '';
          const peekTrim = peek.trim();
          if (peekTrim.length === 0) {
            cursor += 1;
            continue;
          }
          if (peekTrim.startsWith('#')) {
            cursor += 1;
            continue;
          }
          const peekLeading = peek.length - peek.trimStart().length;
          if (peekLeading <= fieldIndent) break;
          if (peekLeading !== childIndent) {
            // A deeper line we don't expect here (e.g. mis-indented).
            cursor += 1;
            continue;
          }
          const childMatch = /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(peek);
          if (!childMatch) {
            cursor += 1;
            continue;
          }
          const childKey = (childMatch[2] ?? '').trim();
          const childRest = (childMatch[3] ?? '').trim();

          if (childRest.startsWith('{') && childRest.endsWith('}')) {
            // Inline-flow scalar map: `{a: 1, b: 2, c: 3}`.
            children[childKey] = parseInlineFlowMap(childRest.slice(1, -1));
            cursor += 1;
            continue;
          }
          if (childRest.length === 0) {
            // Block-mapping body — gather indented `<scalar>: <value>` lines.
            const innerMap: Record<string, string> = {};
            let innerCursor = cursor + 1;
            while (innerCursor < lines.length) {
              const innerPeek = lines[innerCursor] ?? '';
              const innerTrim = innerPeek.trim();
              if (innerTrim.length === 0) {
                innerCursor += 1;
                continue;
              }
              if (innerTrim.startsWith('#')) {
                innerCursor += 1;
                continue;
              }
              const innerLeading =
                innerPeek.length - innerPeek.trimStart().length;
              if (innerLeading <= childIndent) break;
              const innerMatch =
                /^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(innerPeek);
              if (!innerMatch) {
                innerCursor += 1;
                continue;
              }
              const innerKey = (innerMatch[2] ?? '').trim();
              const innerRest = (innerMatch[3] ?? '').trim();
              innerMap[innerKey] = stripQuotes(innerRest);
              innerCursor += 1;
            }
            children[childKey] = innerMap;
            cursor = innerCursor;
            continue;
          }
          // Scalar value (unsupported here — children are expected to be
          // sub-mappings under `bounds:`). Skip silently.
          cursor += 1;
        }
        mapFields[key] = children;
        idx = cursor;
        continue;
      }

      // Nothing indented past the key — treat as empty scalar.
      fields[key] = '';
      idx += 1;
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline flow sequence: `[a, b, c]`. Parse as a list field — easier to
      // consume from the typed surface than a stringly-typed scalar.
      const inner = rest.slice(1, -1).trim();
      const items =
        inner.length === 0
          ? []
          : inner
              .split(',')
              .map((s) => stripQuotes(s.trim()))
              .filter((s) => s.length > 0);
      listFields[key] = items;
      idx += 1;
      continue;
    }

    fields[key] = stripQuotes(rest);
    idx += 1;
  }

  const rawPath = fields['path'];
  if (!rawPath || rawPath.length === 0) return null;

  const rawMode = (fields['mode'] ?? '').trim();
  const mode: AutonomyMode = KNOWN_MODES.has(rawMode as AutonomyMode)
    ? (rawMode as AutonomyMode)
    : 'gated';

  const surface: AutonomySurface = { path: rawPath, mode };
  if (fields['why'] && fields['why'].length > 0) surface.why = fields['why'];
  if (fields['max_pending']) {
    const n = Number.parseInt(fields['max_pending'], 10);
    if (Number.isFinite(n) && n > 0) surface.max_pending = n;
  }
  if (fields['root_key'] && fields['root_key'].length > 0) {
    surface.root_key = fields['root_key'];
  }
  if (fields['unique_by'] && fields['unique_by'].length > 0) {
    surface.unique_by = fields['unique_by'];
  }
  if (listFields['soft_fields'] && listFields['soft_fields'].length > 0) {
    surface.soft_fields = listFields['soft_fields'];
  }
  if (mapFields['bounds']) {
    const bounds = assembleBounds(mapFields['bounds']);
    if (Object.keys(bounds).length > 0) surface.bounds = bounds;
  }
  return surface;
}

/**
 * Parse the inner text of an inline-flow map `{a: 1, b: 2.5, c: 'three'}`.
 * Returns a string→string map; numeric coercion is the caller's problem.
 * Handles single/double-quoted values and stops at top-level commas only —
 * we keep this small since the schema is shallow (no nested braces).
 */
function parseInlineFlowMap(inner: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on commas not inside quotes. Bounds entries don't contain commas
  // inside their values in practice, so this stays simple.
  const parts: string[] = [];
  let current = '';
  let quoted: '"' | "'" | null = null;
  for (const ch of inner) {
    if (quoted) {
      current += ch;
      if (ch === quoted) quoted = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quoted = ch;
      current += ch;
      continue;
    }
    if (ch === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim().length > 0) parts.push(current);

  for (const part of parts) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*?)\s*$/.exec(part);
    if (!m) continue;
    const k = (m[1] ?? '').trim();
    const v = stripQuotes((m[2] ?? '').trim());
    out[k] = v;
  }
  return out;
}

/**
 * Coerce a parsed `bounds:` block (string→string children) into a typed
 * `Record<string, Bound>`. Entries missing `min` or `max`, or whose values
 * aren't finite numbers, are dropped — the executor surfaces a clear refusal
 * at call time when a parameter is missing required fields.
 */
function assembleBounds(
  raw: Record<string, Record<string, string>>,
): Record<string, Bound> {
  const out: Record<string, Bound> = {};
  for (const [paramName, attrs] of Object.entries(raw)) {
    const minStr = attrs['min'];
    const maxStr = attrs['max'];
    if (minStr === undefined || maxStr === undefined) continue;
    const min = Number.parseFloat(minStr);
    const max = Number.parseFloat(maxStr);
    if (!Number.isFinite(min) || !Number.isFinite(max)) continue;
    const bound: Bound = { min, max };
    if (attrs['step'] !== undefined) {
      const step = Number.parseFloat(attrs['step']);
      if (Number.isFinite(step) && step > 0) bound.step = step;
    }
    out[paramName] = bound;
  }
  return out;
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
 * Read recent autonomous-edit commits from the role-home git repo. Returns
 * an empty array when there's no repo, no matching commits, or any git
 * error — never throws. Filters by author email/name, time window, and
 * optionally the changed paths overlapping `autonomous_paths`.
 */
export async function recentAutonomousEdits(
  roleHome: string,
  options: RecentAutonomousEditsOptions = {},
): Promise<AutonomousEdit[]> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const sinceDays = options.since_days ?? DEFAULT_SINCE_DAYS;

  const git = simpleGit(roleHome);
  try {
    if (!(await git.checkIsRepo())) return [];
  } catch {
    return [];
  }

  // We pull a wider net than `limit` because path filtering may discard some
  // commits — but also stay sane (cap at limit * 5).
  const fetchCount = Math.max(limit * 5, limit);
  const args: string[] = [
    `--since=${sinceDays} days ago`,
    `--max-count=${fetchCount}`,
    `--pretty=format:%H%x1f%aI%x1f%an%x1f%ae%x1f%s`,
  ];
  if (options.role_email && options.role_email.length > 0) {
    args.push(`--author=${options.role_email}`);
  } else if (options.role_name && options.role_name.length > 0) {
    args.push(`--author=${options.role_name}`);
  }

  let logOut: string;
  try {
    logOut = await git.raw(['log', ...args]);
  } catch {
    return [];
  }

  const candidates: Omit<AutonomousEdit, 'files'>[] = [];
  for (const rawLine of logOut.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    const parts = line.split('\x1f');
    if (parts.length < 5) continue;
    const sha = parts[0] ?? '';
    if (sha.length === 0) continue;
    candidates.push({
      sha,
      short_sha: sha.slice(0, 7),
      date: parts[1] ?? '',
      author_name: parts[2] ?? '',
      author_email: parts[3] ?? '',
      message: parts[4] ?? '',
    });
  }

  const allowList = options.autonomous_paths;
  const out: AutonomousEdit[] = [];
  for (const candidate of candidates) {
    let files: string[];
    try {
      // `--root` makes the initial commit (no parent) produce file output too;
      // without it `diff-tree` silently returns nothing for that commit.
      const filesOut = await git.raw([
        'diff-tree',
        '--no-commit-id',
        '--name-only',
        '-r',
        '--root',
        candidate.sha,
      ]);
      files = filesOut
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } catch {
      files = [];
    }
    if (allowList && allowList.length > 0) {
      const overlap = files.some((f) => allowList.some((prefix) => pathMatches(f, prefix)));
      if (!overlap) continue;
    }
    out.push({ ...candidate, files });
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * `prefix` from autonomy.yaml is either a directory (`memory/`) or a file
 * (`lib/research-strategies.yaml`). For directories we match by prefix; for
 * files we match exactly.
 */
function pathMatches(file: string, prefix: string): boolean {
  if (prefix.endsWith('/')) return file === prefix.slice(0, -1) || file.startsWith(prefix);
  return file === prefix;
}
