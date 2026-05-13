import fs from 'node:fs/promises';
import path from 'node:path';

import { simpleGit } from 'simple-git';

import { assembleActivity, type ActivityEntry } from './activity-loader.js';
import { loadAutonomy, type AutonomyConfig, type AutonomySurface } from './autonomy-loader.js';
import { getLogGlob } from './role-home.js';
import { loadVerbs, type VerbSummary } from './verbs-loader.js';
import { CHAT_TOOLS } from './chat/tool-schemas.js';

/**
 * The capabilities report renders the role's "what *can* I do" surface. Four
 * groups, each backed by a different source:
 *
 *   - chatTools  — static toolset from {@link CHAT_TOOLS}, joined to 30-day
 *                  usage counts from the activity log
 *   - mcps       — placeholder until issue #25 lands MCP infrastructure
 *   - verbs      — live verbs from `verbs/<slug>.md` joined to verb-started /
 *                  verb-completed activity entries
 *   - refData    — `lib/*` files (excluding the constitutional set) joined to
 *                  their autonomy mode + most recent role-author commit
 *
 * The shape is intentionally fully-resolved (no async fetches at render time)
 * so the page can render statically once it has the report in hand.
 */

export type ChatToolAutonomyMode =
  | 'full'
  | 'append-only'
  | 'inline-enrichment'
  | 'bounded'
  | 'gated'
  | 'implicit-full';

export interface ChatToolCapability {
  name: string;
  description: string;
  autonomyMode: ChatToolAutonomyMode;
  /** Count of matching activity entries in the last 30 days. */
  callCount30d: number;
  /** ISO timestamp of the most recent matching entry, or null when never invoked. */
  lastInvoked: string | null;
}

export interface McpPlaceholder {
  /** Hardcoded for now. Once issue #25 lands, the shape extends with `servers: McpServer[]`. */
  configured: false;
  message: string;
}

export type McpReport = McpPlaceholder;

export interface VerbOutcomeCounts {
  success: number;
  partial: number;
  failed: number;
  skipped: number;
}

export interface VerbCapability {
  slug: string;
  description: string;
  /** Count of `verb_started` entries in the last 30 days. */
  invocationCount30d: number;
  outcomes: VerbOutcomeCounts;
  /** ISO timestamp of the most recent `verb_started` entry. */
  lastInvoked: string | null;
}

export interface RefDataCapability {
  filename: string;
  autonomyMode: string | null;
  /** Most recent role-author commit touching this file. Null when git unavailable or no match. */
  lastEditIso: string | null;
  /** Per-mode hint (e.g. "max 5 pending"). Null when the mode has no useful hint. */
  modeHint: string | null;
}

export interface CapabilitiesReport {
  chatTools: ChatToolCapability[];
  mcps: McpReport;
  verbs: VerbCapability[];
  refData: RefDataCapability[];
}

/**
 * Same set the chat-side autonomy gate refuses unconditionally. Kept inline
 * (rather than imported from `chat/autonomy-gate.ts`) to keep the dependency
 * graph small — the capabilities loader has no reason to pull the chat
 * subsystem's surface into its tree.
 */
const CONSTITUTIONAL_LIB_FILES: ReadonlySet<string> = new Set<string>([
  'autonomy.yaml',
  'compliance.yaml',
  'customers.yaml',
  'tools.yaml',
]);

/**
 * Mapping from chat-tool name to the activity-entry shape that counts as one
 * invocation. Most tools auto-instrument with `action: 'tool_call'` and the
 * tool name. `log_decision`, `run_verb`, and `complete_verb` emit their own
 * action verbs instead. The lib-surgery tools (`append_entry`, `enrich_entry`,
 * `adjust_param`) act on operator-opened lib files, so their effective
 * autonomy is per-file rather than per-tool — the page reports
 * `implicit-full` for the tool row itself and surfaces the real per-file
 * modes in the reference-data section.
 */
function matchesToolInvocation(entry: ActivityEntry, toolName: string): boolean {
  if (toolName === 'log_decision') {
    return entry.action === 'decision';
  }
  if (toolName === 'run_verb') {
    return entry.action === 'verb_started';
  }
  if (toolName === 'complete_verb') {
    return entry.action === 'verb_completed';
  }
  return entry.action === 'tool_call' && entry.tool === toolName;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const ROLE_AUTHOR_EMAIL = 'role@praxis.local';
/**
 * Wide net so a 30-day window comfortably fits even for chatty roles. The
 * loader caps the slice rather than walking the JSONL repeatedly per tool.
 */
const ACTIVITY_LIMIT = 5000;

export async function loadCapabilities(
  roleHome: string,
  now: Date = new Date(),
): Promise<CapabilitiesReport> {
  const cutoff = now.getTime() - THIRTY_DAYS_MS;

  const [activityRes, verbsRes, autonomyRes, libFilesRes] = await Promise.allSettled([
    assembleActivity(roleHome, getLogGlob(), ACTIVITY_LIMIT),
    loadVerbs(roleHome),
    loadAutonomy(roleHome),
    listLibFilesFiltered(roleHome),
  ]);

  const activity: ActivityEntry[] = activityRes.status === 'fulfilled' ? activityRes.value : [];
  const verbs = verbsRes.status === 'fulfilled' ? verbsRes.value.live : [];
  const autonomy: AutonomyConfig | null =
    autonomyRes.status === 'fulfilled' ? autonomyRes.value : null;
  const libFiles: string[] = libFilesRes.status === 'fulfilled' ? libFilesRes.value : [];

  const chatTools = buildChatToolCapabilities(activity, cutoff);
  const verbCapabilities = buildVerbCapabilities(verbs, activity, cutoff);
  const refData = await buildRefDataCapabilities(roleHome, libFiles, autonomy);

  return {
    chatTools,
    mcps: {
      configured: false,
      message: 'No MCPs configured. MCP support in issue #25.',
    },
    verbs: verbCapabilities,
    refData,
  };
}

function buildChatToolCapabilities(
  activity: ActivityEntry[],
  cutoff: number,
): ChatToolCapability[] {
  const out: ChatToolCapability[] = [];
  for (const tool of CHAT_TOOLS) {
    let callCount30d = 0;
    let lastInvoked: string | null = null;
    for (const entry of activity) {
      if (!matchesToolInvocation(entry, tool.name)) continue;
      const ts = entry.timestamp ?? '';
      const t = Date.parse(ts);
      if (Number.isNaN(t)) continue;
      if (t >= cutoff) callCount30d += 1;
      if (lastInvoked === null || ts.localeCompare(lastInvoked) > 0) {
        lastInvoked = ts;
      }
    }
    out.push({
      name: tool.name,
      description: firstLine(typeof tool.description === 'string' ? tool.description : ''),
      autonomyMode: 'implicit-full',
      callCount30d,
      lastInvoked,
    });
  }
  return out;
}

function buildVerbCapabilities(
  verbs: VerbSummary[],
  activity: ActivityEntry[],
  cutoff: number,
): VerbCapability[] {
  const out: VerbCapability[] = [];
  for (const verb of verbs) {
    const slug = path.basename(verb.file, '.md');
    let invocationCount30d = 0;
    let lastInvoked: string | null = null;
    const outcomes: VerbOutcomeCounts = { success: 0, partial: 0, failed: 0, skipped: 0 };

    for (const entry of activity) {
      if (entry.verb !== slug) continue;
      const ts = entry.timestamp ?? '';
      const t = Date.parse(ts);
      if (Number.isNaN(t)) continue;

      if (entry.action === 'verb_started') {
        if (t >= cutoff) invocationCount30d += 1;
        if (lastInvoked === null || ts.localeCompare(lastInvoked) > 0) {
          lastInvoked = ts;
        }
      } else if (entry.action === 'verb_completed' && t >= cutoff) {
        const outcome = entry.outcome;
        if (outcome === 'success' || outcome === 'partial' || outcome === 'failed' || outcome === 'skipped') {
          outcomes[outcome] += 1;
        }
      }
    }

    out.push({
      slug,
      description: verb.label,
      invocationCount30d,
      outcomes,
      lastInvoked,
    });
  }
  return out;
}

async function buildRefDataCapabilities(
  roleHome: string,
  libFiles: string[],
  autonomy: AutonomyConfig | null,
): Promise<RefDataCapability[]> {
  const out: RefDataCapability[] = [];
  for (const filename of libFiles) {
    const surface = findSurfaceForLibFile(autonomy, filename);
    const autonomyMode = surface ? surface.mode : null;
    const modeHint = surface ? deriveModeHint(surface) : null;
    const lastEditIso = await mostRecentRoleCommitDate(roleHome, `lib/${filename}`);
    out.push({ filename, autonomyMode, lastEditIso, modeHint });
  }
  return out;
}

/**
 * Match the autonomy surface (if any) whose `path` corresponds to this lib
 * file. Surfaces are recorded as `lib/<filename>` in autonomy.yaml.
 */
function findSurfaceForLibFile(
  autonomy: AutonomyConfig | null,
  filename: string,
): AutonomySurface | null {
  if (!autonomy) return null;
  const expectedPath = `lib/${filename}`;
  for (const surface of autonomy.surfaces) {
    if (surface.path === expectedPath) return surface;
  }
  return null;
}

function deriveModeHint(surface: AutonomySurface): string | null {
  if (surface.mode === 'append-only' && surface.max_pending !== undefined) {
    return `max ${surface.max_pending} pending`;
  }
  if (surface.mode === 'inline-enrichment') {
    return 'editable fields per entry';
  }
  if (surface.mode === 'bounded' && surface.bounds) {
    const entries = Object.entries(surface.bounds);
    if (entries.length === 0) return null;
    const [paramName, bound] = entries[0]!;
    const stepPart = bound.step !== undefined ? ` step ${bound.step}` : '';
    return `params: ${paramName} [${bound.min}..${bound.max}${stepPart}]`;
  }
  return null;
}

async function listLibFilesFiltered(roleHome: string): Promise<string[]> {
  const libDir = path.join(roleHome, 'lib');
  let entries;
  try {
    entries = await fs.readdir(libDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && /\.ya?ml$/i.test(e.name))
    .map((e) => e.name)
    .filter((name) => !CONSTITUTIONAL_LIB_FILES.has(name))
    .sort();
}

/**
 * Walk `git log --author=role@praxis.local -- lib/<file>` and return the
 * most recent commit's ISO author date. Returns null on any git failure or
 * when no matching commit exists — never throws.
 */
async function mostRecentRoleCommitDate(
  roleHome: string,
  relativePath: string,
): Promise<string | null> {
  const git = simpleGit(roleHome);
  try {
    if (!(await git.checkIsRepo())) return null;
  } catch {
    return null;
  }
  try {
    const out = await git.raw([
      'log',
      `--author=${ROLE_AUTHOR_EMAIL}`,
      '--max-count=1',
      '--pretty=format:%aI',
      '--',
      relativePath,
    ]);
    const trimmed = out.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/**
 * First non-empty line of a string. Tool schema descriptions are written as
 * multi-sentence prose; the capabilities page wants a single short blurb.
 */
function firstLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return '';
}
