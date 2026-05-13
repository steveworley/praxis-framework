import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { renderMarkdown } from '@/lib/markdown.js';

const CONVERSATIONS_REL = path.posix.join('memory', 'conversations');

/**
 * Turn roles on disk:
 *   - `user` / `assistant`: the two real speakers in the transcript
 *   - `summary`: a synthetic compressed-history block written by the
 *     operator-driven `summariseThread()` flow. Persists as
 *     `## Summary · turns N-M · <iso>` and is treated as a user-role message
 *     when feeding history back to Anthropic.
 */
export type TurnRole = 'user' | 'assistant' | 'summary';

/**
 * A tool call the model made during the assistant turn, persisted alongside
 * the reply text so the dashboard can render the action inline. Stored as an
 * HTML-comment-fenced JSON block at the start of the turn body; see
 * `parseTurns()` / `renderTurn()` for the on-disk shape.
 */
export interface PersistedToolCall {
  name: string;
  input: Record<string, unknown>;
  /** Truthy result.ok = success; the summary/data shape mirrors ToolResult. */
  result: {
    ok: boolean;
    summary?: string;
    data?: Record<string, unknown>;
    error?: string;
  };
}

export interface Turn {
  role: TurnRole;
  /** ISO 8601 timestamp (no fractional seconds). */
  timestamp: string;
  content: string;
  /** Tool calls made during this turn (assistant turns only). */
  toolCalls?: PersistedToolCall[];
  /** Set on summary turns: the inclusive 1-based range of original turns folded in. */
  summaryRange?: { from: number; to: number };
}

export interface ThreadMeta {
  thread_id: string;
  title: string;
  /** ISO 8601 timestamp. */
  created: string;
  /** ISO 8601 timestamp; bumped on every appendTurn. */
  updated: string;
}

export interface ThreadSummary extends ThreadMeta {
  message_count: number;
  /** Most recent user message text, truncated for the list view. Empty if none yet. */
  last_user_message: string;
}

export interface ThreadDetail {
  thread: ThreadMeta;
  turns: Turn[];
}

/**
 * Turn shape sent to the chat client. Identical to `Turn` plus a pre-rendered
 * `content_html` string so the Alpine transcript can `x-html` the body
 * directly — markdown rendering stays on the server and the chat page ships
 * no markdown renderer to the browser. See `serializeTurn` below.
 */
export interface TurnForResponse extends Turn {
  content_html: string;
}

/**
 * Project a persisted `Turn` into the on-wire shape returned by the chat API
 * routes. Renders `content` to HTML via the shared markdown pipeline (same
 * renderer used by MemoEntry / FullEscalation). The raw `content` is left in
 * place too so the client can still read it if it needs to (e.g. copying the
 * markdown body to the clipboard).
 */
export function serializeTurn(turn: Turn): TurnForResponse {
  return { ...turn, content_html: renderMarkdown(turn.content) };
}

/**
 * Generate a thread ID with a date prefix + short random suffix. Sortable by
 * date in the filename; the random suffix avoids collisions when multiple
 * threads start on the same day.
 */
export function generateThreadId(now: Date = new Date()): string {
  const date = now.toISOString().slice(0, 10);
  const suffix = randomBytes(3).toString('hex');
  return `${date}-${suffix}`;
}

/**
 * Derive a thread title from its first user message: first ~8 words, ~80
 * chars max, single line. Falls back to "New chat" when the message is empty.
 */
export function deriveTitle(firstMessage: string): string {
  const cleaned = firstMessage.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return 'New chat';
  const words = cleaned.split(' ').slice(0, 8).join(' ');
  if (words.length <= 80) return words;
  return `${words.slice(0, 77).trimEnd()}…`;
}

function nowIsoSeconds(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function conversationsDir(roleHome: string): string {
  return path.join(roleHome, CONVERSATIONS_REL);
}

function threadPath(roleHome: string, threadId: string): string {
  if (!isSafeThreadId(threadId)) {
    throw new Error(`Invalid thread_id: ${threadId}`);
  }
  return path.join(conversationsDir(roleHome), `${threadId}.md`);
}

function isSafeThreadId(threadId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(threadId) && !threadId.includes('..');
}

/**
 * Create a fresh thread file with frontmatter only. The first user turn is
 * persisted separately via `appendTurn()` — `appendTurn` is the single source
 * of truth for turn writes so the same message can't land twice (POST
 * /api/chat/threads followed by POST /api/chat/message would otherwise
 * duplicate the user turn on disk).
 *
 * The title is still derived from `firstMessage` because the caller doesn't
 * pass a title separately and we want a useful list-view label immediately.
 */
export async function createThread(
  roleHome: string,
  firstMessage: string,
): Promise<{ thread_id: string; title: string }> {
  const threadId = generateThreadId();
  const title = deriveTitle(firstMessage);
  const now = nowIsoSeconds();

  await fs.mkdir(conversationsDir(roleHome), { recursive: true });

  const frontmatter = renderFrontmatter({
    thread_id: threadId,
    title,
    created: now,
    updated: now,
  });
  const body = `${frontmatter}\n`;

  await fs.writeFile(threadPath(roleHome, threadId), body, 'utf-8');
  return { thread_id: threadId, title };
}

/**
 * Append a turn to an existing thread, bumping `updated:` in frontmatter.
 */
export async function appendTurn(
  roleHome: string,
  threadId: string,
  turn: Omit<Turn, 'timestamp' | 'toolCalls'> & {
    timestamp?: string;
    toolCalls?: PersistedToolCall[];
  },
): Promise<Turn> {
  const file = threadPath(roleHome, threadId);
  const text = await fs.readFile(file, 'utf-8');
  const parsed = parseThreadFile(text);
  if (!parsed) {
    throw new Error(`Thread file is malformed: ${threadId}`);
  }

  const finalTimestamp = turn.timestamp ?? nowIsoSeconds();
  const newTurn: Turn = {
    role: turn.role,
    timestamp: finalTimestamp,
    content: turn.content,
  };
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    newTurn.toolCalls = turn.toolCalls;
  }
  const updatedMeta: ThreadMeta = { ...parsed.thread, updated: finalTimestamp };
  const turns = [...parsed.turns, newTurn];

  const next = renderThreadFile(updatedMeta, turns);
  await fs.writeFile(file, next, 'utf-8');
  return newTurn;
}

/**
 * Load a single thread's metadata and full turn history.
 */
export async function loadThread(
  roleHome: string,
  threadId: string,
): Promise<ThreadDetail> {
  const text = await fs.readFile(threadPath(roleHome, threadId), 'utf-8');
  const parsed = parseThreadFile(text);
  if (!parsed) {
    throw new Error(`Thread file is malformed: ${threadId}`);
  }
  return parsed;
}

/**
 * List all threads with summary info, sorted by `updated` desc. Skips files
 * whose frontmatter can't be parsed (logged via console.warn, not thrown).
 */
export async function listThreads(roleHome: string): Promise<ThreadSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(conversationsDir(roleHome));
  } catch {
    return [];
  }

  const summaries: ThreadSummary[] = [];
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    const file = path.join(conversationsDir(roleHome), name);
    let text: string;
    try {
      text = await fs.readFile(file, 'utf-8');
    } catch {
      continue;
    }
    const parsed = parseThreadFile(text);
    if (!parsed) {
      console.warn(`Skipping malformed thread file: ${name}`);
      continue;
    }
    const userTurns = parsed.turns.filter((t) => t.role === 'user');
    const lastUser = userTurns[userTurns.length - 1]?.content ?? '';
    summaries.push({
      ...parsed.thread,
      message_count: parsed.turns.length,
      last_user_message: truncatePreview(lastUser),
    });
  }

  summaries.sort((a, b) => b.updated.localeCompare(a.updated));
  return summaries;
}

/**
 * Permanently delete a thread file. Throws if the file doesn't exist.
 */
export async function deleteThread(roleHome: string, threadId: string): Promise<void> {
  await fs.unlink(threadPath(roleHome, threadId));
}

function truncatePreview(text: string, max = 140): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return `${collapsed.slice(0, max - 1).trimEnd()}…`;
}

// ---- file format ---------------------------------------------------------

const TURN_HEADING_RE = /^##\s+(User|Assistant)\s+·\s+(\S+)\s*$/;
const SUMMARY_HEADING_RE = /^##\s+Summary\s+·\s+turns\s+(\d+)-(\d+)\s+·\s+(\S+)\s*$/;
const ANY_TURN_HEADING_RE = /^##\s+(User|Assistant|Summary)\b/;

interface ParsedThread {
  thread: ThreadMeta;
  turns: Turn[];
}

/**
 * Parse a thread file. Returns null on malformed frontmatter (caller decides
 * how to surface). A file with valid frontmatter but no turns parses cleanly
 * with an empty `turns` array.
 */
export function parseThreadFile(text: string): ParsedThread | null {
  const fmMatch = /^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/.exec(text);
  if (!fmMatch) return null;

  const fields: Record<string, string> = {};
  for (const rawLine of (fmMatch[1] ?? '').split('\n')) {
    const colonIdx = rawLine.indexOf(':');
    if (colonIdx < 0) continue;
    const key = rawLine.slice(0, colonIdx).trim().toLowerCase();
    let value = rawLine.slice(colonIdx + 1).trim();
    if (value.length >= 2) {
      const f = value[0];
      const l = value[value.length - 1];
      if ((f === '"' && l === '"') || (f === "'" && l === "'")) {
        value = value.slice(1, -1);
      }
    }
    if (key.length > 0) fields[key] = value;
  }

  const threadId = fields['thread_id'];
  const title = fields['title'];
  const created = fields['created'];
  const updated = fields['updated'];
  if (!threadId || !title || !created || !updated) return null;

  const thread: ThreadMeta = { thread_id: threadId, title, created, updated };
  const body = fmMatch[2] ?? '';
  const turns = parseTurns(body);
  return { thread, turns };
}

function parseTurns(body: string): Turn[] {
  const turns: Turn[] = [];
  const lines = body.split('\n');

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const turnMatch = TURN_HEADING_RE.exec(line);
    const summaryMatch = SUMMARY_HEADING_RE.exec(line);
    if (!turnMatch && !summaryMatch) {
      i += 1;
      continue;
    }

    let role: TurnRole;
    let timestamp: string;
    let summaryRange: { from: number; to: number } | null = null;
    if (summaryMatch) {
      role = 'summary';
      timestamp = (summaryMatch[3] ?? '').trim();
      summaryRange = {
        from: Number.parseInt(summaryMatch[1] ?? '0', 10),
        to: Number.parseInt(summaryMatch[2] ?? '0', 10),
      };
    } else {
      // turnMatch is guaranteed non-null by the early-continue above.
      role = (turnMatch![1] ?? '').toLowerCase() === 'user' ? 'user' : 'assistant';
      timestamp = (turnMatch![2] ?? '').trim();
    }

    // Consume content until the next turn heading or EOF. "Turn heading"
    // here includes the synthetic `## Summary` block so two summary blocks
    // (re-summarise path) parse as two separate turns rather than merging.
    i += 1;
    const contentLines: string[] = [];
    while (i < lines.length && !ANY_TURN_HEADING_RE.test(lines[i] ?? '')) {
      contentLines.push(lines[i] ?? '');
      i += 1;
    }
    // Strip the single leading + trailing blank lines that decorate every turn.
    while (contentLines.length > 0 && contentLines[0]!.trim().length === 0) {
      contentLines.shift();
    }
    while (contentLines.length > 0 && contentLines[contentLines.length - 1]!.trim().length === 0) {
      contentLines.pop();
    }

    const { toolCalls, remaining } = extractToolCallFence(contentLines);
    const turn: Turn = { role, timestamp, content: remaining.join('\n') };
    if (toolCalls && toolCalls.length > 0) turn.toolCalls = toolCalls;
    if (summaryRange) turn.summaryRange = summaryRange;
    turns.push(turn);
  }

  return turns;
}

/**
 * Tool calls are persisted at the head of an assistant turn body as an
 * HTML-comment-fenced JSON array. Shape:
 *
 *   <!-- praxis:tool_calls
 *   [{"name":"write_memory","input":{...},"result":{...}}]
 *   -->
 *
 * The fence is invisible in any markdown renderer, round-trips losslessly,
 * and keeps the file readable when an operator opens it in their editor.
 * Falls back silently to "no tool calls" if the JSON doesn't parse — we'd
 * rather lose the metadata than lose the conversation.
 */
function extractToolCallFence(lines: string[]): {
  toolCalls: PersistedToolCall[] | null;
  remaining: string[];
} {
  if (lines.length === 0) return { toolCalls: null, remaining: lines };
  if ((lines[0] ?? '').trim() !== '<!-- praxis:tool_calls') {
    return { toolCalls: null, remaining: lines };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '-->') {
      end = i;
      break;
    }
  }
  if (end < 0) return { toolCalls: null, remaining: lines };
  const jsonText = lines.slice(1, end).join('\n').trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { toolCalls: null, remaining: lines };
  }
  if (!Array.isArray(parsed)) return { toolCalls: null, remaining: lines };
  const toolCalls = parsed.filter(isPersistedToolCall) as PersistedToolCall[];

  // Drop the fence + any single trailing blank line after it.
  const after = lines.slice(end + 1);
  while (after.length > 0 && (after[0] ?? '').trim().length === 0) {
    after.shift();
  }
  return { toolCalls, remaining: after };
}

function isPersistedToolCall(value: unknown): value is PersistedToolCall {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['name'] !== 'string') return false;
  if (typeof v['input'] !== 'object' || v['input'] === null) return false;
  if (typeof v['result'] !== 'object' || v['result'] === null) return false;
  const result = v['result'] as Record<string, unknown>;
  return typeof result['ok'] === 'boolean';
}

function renderThreadFile(meta: ThreadMeta, turns: Turn[]): string {
  const fm = renderFrontmatter(meta);
  const turnsRendered = turns.map(renderTurn).join('\n\n');
  return `${fm}\n\n${turnsRendered}\n`;
}

function renderFrontmatter(meta: ThreadMeta): string {
  const lines = [
    '---',
    `thread_id: ${meta.thread_id}`,
    `title: ${escapeFrontmatterValue(meta.title)}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    '---',
  ];
  return lines.join('\n');
}

function escapeFrontmatterValue(value: string): string {
  // Quote when the value contains characters that would break naive parsing.
  if (/^[A-Za-z0-9 _.,!?;:()\-—–'’"]+$/.test(value) && !value.includes(':')) {
    return value;
  }
  // Use single quotes; escape any single quotes by doubling them (YAML rule).
  return `'${value.replace(/'/g, "''")}'`;
}

function renderTurn(turn: Turn): string {
  let heading: string;
  if (turn.role === 'summary') {
    const range = turn.summaryRange ?? { from: 0, to: 0 };
    heading = `## Summary · turns ${range.from}-${range.to} · ${turn.timestamp}`;
  } else {
    const label = turn.role === 'user' ? 'User' : 'Assistant';
    heading = `## ${label} · ${turn.timestamp}`;
  }
  const parts = [heading, ''];
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    parts.push(
      '<!-- praxis:tool_calls',
      JSON.stringify(turn.toolCalls),
      '-->',
      '',
    );
  }
  parts.push(turn.content);
  return parts.join('\n');
}
