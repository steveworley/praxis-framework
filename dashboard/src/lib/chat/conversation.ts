import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONVERSATIONS_REL = path.posix.join('memory', 'conversations');

export type TurnRole = 'user' | 'assistant';

export interface Turn {
  role: TurnRole;
  /** ISO 8601 timestamp (no fractional seconds). */
  timestamp: string;
  content: string;
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
 * Create a fresh thread file with frontmatter + the first user turn.
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
  const firstTurn = renderTurn({ role: 'user', timestamp: now, content: firstMessage });
  const body = `${frontmatter}\n\n${firstTurn}\n`;

  await fs.writeFile(threadPath(roleHome, threadId), body, 'utf-8');
  return { thread_id: threadId, title };
}

/**
 * Append a turn to an existing thread, bumping `updated:` in frontmatter.
 */
export async function appendTurn(
  roleHome: string,
  threadId: string,
  turn: Omit<Turn, 'timestamp'> & { timestamp?: string },
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
    const match = TURN_HEADING_RE.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const role: TurnRole = (match[1] ?? '').toLowerCase() === 'user' ? 'user' : 'assistant';
    const timestamp = (match[2] ?? '').trim();

    // Consume content until the next turn heading or EOF.
    i += 1;
    const contentLines: string[] = [];
    while (i < lines.length && !TURN_HEADING_RE.test(lines[i] ?? '')) {
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
    turns.push({ role, timestamp, content: contentLines.join('\n') });
  }

  return turns;
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
  const heading = turn.role === 'user' ? 'User' : 'Assistant';
  return `## ${heading} · ${turn.timestamp}\n\n${turn.content}`;
}
