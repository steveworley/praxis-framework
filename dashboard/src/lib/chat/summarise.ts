import fs from 'node:fs/promises';
import path from 'node:path';

import Anthropic from '@anthropic-ai/sdk';

import { commitChange } from '../audit.js';

import {
  AnthropicChatError,
  MissingApiKeyError,
  resolveChatModel,
} from './anthropic.js';
import {
  loadThread,
  type ThreadMeta,
  type Turn,
} from './conversation.js';
import { estimateThreadTokens } from './tokens.js';

// We re-serialise turns into the on-disk shape inside summarise.ts so we
// don't have to expose the private renderTurn helper from conversation.ts.
// The format is stable (frontmatter + `## User`/`## Assistant`/`## Summary`
// headings + optional tool-call fence + body) and round-trip-tested in
// conversation.test.ts.

/**
 * Operator-driven thread summarisation.
 *
 * The operator clicks "Summarise older turns" on a long thread; we fold the
 * older 70% of turns into a single `## Summary · turns N-M · <iso>` block
 * and preserve the newest 30% verbatim. The original turns are MOVED (not
 * copied) into `memory/conversations/archived/<thread_id>-turns-N-M-<slug>.md`
 * so the audit trail is intact — `git revert <sha>` on the summarise commit
 * restores the thread to its pre-summarise state.
 *
 * Refusal cases:
 *   - Thread has fewer than `MIN_TURNS_TO_SUMMARISE` turns
 *   - Thread file is malformed or missing
 *   - Anthropic call fails or the API key is missing
 *
 * The split point uses `Math.max(MIN_NEW_KEPT, floor(len * OLDER_RATIO))` so
 * a re-summarise (where the thread already starts with a `## Summary` block)
 * always leaves at least the newest two turns verbatim — and folds the prior
 * summary into the new one along with the older turns we're archiving.
 */

const OLDER_RATIO = 0.7;
const MIN_TURNS_TO_SUMMARISE = 4;
const MAX_SUMMARY_TOKENS = 1024;

export interface SummariseSuccess {
  ok: true;
  /** The summary text the model produced for the archived turns. */
  summary: string;
  /** Path (relative to roleHome) of the new archived turns file. */
  archivedPath: string;
  /** Path (relative to roleHome) of the rewritten thread file. */
  threadPath: string;
  /** Indices of the original turns that were folded in (1-based, inclusive). */
  turnRange: { from: number; to: number };
  /** Token estimate of the thread before summarisation (history only). */
  tokensBefore: number;
  /** Token estimate of the thread after summarisation (history only). */
  tokensAfter: number;
  /** Commit SHA of the audit commit; absent on commit warning. */
  commitSha?: string;
  /** Short SHA when present. */
  commitShortSha?: string;
  /** Audit warning surfaced from `commitChange` (e.g. commit failed cleanly). */
  commitWarning?: string;
}

export interface SummariseFailure {
  ok: false;
  error: string;
}

export type SummariseResult = SummariseSuccess | SummariseFailure;

export interface SummariseOptions {
  /** Override the chat model. Falls back to PRAXIS_CHAT_MODEL env var, then the hard default. */
  model?: string;
  /** Optional clock for deterministic tests. */
  now?: Date;
}

const CONVERSATIONS_REL = path.posix.join('memory', 'conversations');
const ARCHIVED_REL = path.posix.join('memory', 'conversations', 'archived');

/**
 * Summarise an existing thread. Single entry point — see module doc for
 * semantics. Never throws on Anthropic / git errors; returns
 * `{ ok: false, error }` so the API route can surface the failure cleanly.
 */
export async function summariseThread(
  roleHome: string,
  threadId: string,
  options: SummariseOptions = {},
): Promise<SummariseResult> {
  let thread;
  try {
    thread = await loadThread(roleHome, threadId);
  } catch (error: unknown) {
    return fail(`thread '${threadId}' could not be loaded: ${errorMessage(error)}`);
  }

  if (thread.turns.length < MIN_TURNS_TO_SUMMARISE) {
    return fail(
      `thread '${threadId}' has only ${thread.turns.length} turn(s); need at least ${MIN_TURNS_TO_SUMMARISE} to summarise.`,
    );
  }

  const splitIndex = computeSplitIndex(thread.turns.length);
  const olderTurns = thread.turns.slice(0, splitIndex);
  const newerTurns = thread.turns.slice(splitIndex);

  if (olderTurns.length === 0 || newerTurns.length === 0) {
    return fail(
      `thread '${threadId}' could not be split cleanly (older=${olderTurns.length}, newer=${newerTurns.length}).`,
    );
  }

  // Token estimate before — used in the result envelope so the UI can surface
  // "from ~52K → ~12K" if it wants. System prompt is excluded here so the
  // number is comparable to the per-thread budget the UI already shows.
  const tokensBefore = estimateThreadTokens(thread.turns, '').history;

  let summaryText: string;
  try {
    summaryText = await callAnthropicForSummary(olderTurns, options.model);
  } catch (error: unknown) {
    if (error instanceof MissingApiKeyError) {
      return fail(error.message);
    }
    if (error instanceof AnthropicChatError) {
      return fail(error.message);
    }
    return fail(`summarisation request failed: ${errorMessage(error)}`);
  }

  const now = options.now ?? new Date();
  const archivedAtIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const archivedAtSlug = archivedAtIso.replace(/[:T]/g, '-').replace(/Z$/, 'z');
  const turnRange = { from: 1, to: splitIndex };

  const archivedRel = path.posix.join(
    ARCHIVED_REL,
    `${threadId}-turns-${turnRange.from}-${turnRange.to}-${archivedAtSlug}.md`,
  );
  const threadRel = path.posix.join(CONVERSATIONS_REL, `${threadId}.md`);
  const archivedAbs = path.join(roleHome, archivedRel);
  const threadAbs = path.join(roleHome, threadRel);

  if (await fileExists(archivedAbs)) {
    return fail(
      `archived file ${archivedRel} already exists. Resolve the collision with your operator before retrying.`,
    );
  }

  const archivedBody = renderArchivedFile({
    thread,
    olderTurns,
    turnRange,
    archivedAtIso,
  });
  const summaryTurn: Turn = {
    role: 'summary',
    timestamp: archivedAtIso,
    content: summaryText.trim(),
    summaryRange: turnRange,
  };
  const newThreadBody = renderRewrittenThread({
    meta: { ...thread.thread, updated: archivedAtIso },
    summaryTurn,
    newerTurns,
  });

  // Write the archived file first, then rewrite the thread. If the second
  // write fails we leave the archived copy in place — it's still a valid
  // audit record of what was there, and the thread file is untouched, so the
  // operator can retry without losing turns.
  try {
    await fs.mkdir(path.dirname(archivedAbs), { recursive: true });
    await fs.writeFile(archivedAbs, archivedBody, 'utf-8');
  } catch (error: unknown) {
    return fail(`could not write archived file ${archivedRel}: ${errorMessage(error)}`);
  }
  try {
    await fs.writeFile(threadAbs, newThreadBody, 'utf-8');
  } catch (error: unknown) {
    // Roll back the archived write so the operator doesn't see an orphan.
    await fs.unlink(archivedAbs).catch(() => {});
    return fail(`could not rewrite thread file ${threadRel}: ${errorMessage(error)}`);
  }

  const commit = await commitChange({
    roleHome,
    actor: 'role',
    filePaths: [threadRel, archivedRel],
    scope: 'conversation',
    subject: `summarise ${threadId} turns ${turnRange.from}-${turnRange.to}`,
    body: `Archived ${olderTurns.length} turn(s) into ${archivedRel} and rewrote the thread to start with a Summary block. ${newerTurns.length} turn(s) preserved verbatim.`,
  });

  const tokensAfter = estimateThreadTokens([summaryTurn, ...newerTurns], '').history;

  const result: SummariseSuccess = {
    ok: true,
    summary: summaryText,
    archivedPath: archivedRel,
    threadPath: threadRel,
    turnRange,
    tokensBefore,
    tokensAfter,
  };
  if (commit.committed && commit.sha) {
    result.commitSha = commit.sha;
    if (commit.shortSha) result.commitShortSha = commit.shortSha;
  }
  if (commit.warning) {
    result.commitWarning = commit.warning;
  }
  return result;
}

/**
 * Split the thread so the older 70% folds into the summary and the newest
 * turns stay verbatim. Always keeps at least one turn on each side when the
 * thread is long enough to qualify (`MIN_TURNS_TO_SUMMARISE`).
 */
function computeSplitIndex(turnCount: number): number {
  const raw = Math.floor(turnCount * OLDER_RATIO);
  if (raw < 1) return 1;
  if (raw >= turnCount) return turnCount - 1;
  return raw;
}

/**
 * Call Anthropic for a summary of the older turns. Uses the same SDK +
 * model-resolution path as the chat loop, but without the tool harness — a
 * single one-shot request, no iteration, no tool_use replay. We use a higher
 * `max_tokens` than the regular chat loop because summaries are dense.
 */
async function callAnthropicForSummary(
  olderTurns: readonly Turn[],
  modelOverride: string | undefined,
): Promise<string> {
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey || apiKey.length === 0) {
    throw new MissingApiKeyError();
  }
  const client = new Anthropic({ apiKey });

  const transcript = olderTurns
    .map((turn) => {
      const label = turn.role === 'user' ? 'Operator' : 'Role';
      return `### ${label} · ${turn.timestamp}\n\n${turn.content.trim()}`;
    })
    .join('\n\n');

  const systemPrompt = [
    'You are a conversation summariser working inside the Praxis framework.',
    '',
    'You will receive the older portion of a markdown-formatted conversation between an operator and their role-based agent. Produce a faithful summary that preserves:',
    '- Facts established (about people, accounts, the role itself).',
    '- Decisions made and their rationale.',
    '- Tasks assigned or commitments captured.',
    '- Open questions or follow-ups still outstanding.',
    '',
    'Constraints:',
    '- Use bullet points organised by topic. Group related items.',
    '- Do not invent details. If the conversation hedged, your summary should hedge.',
    '- Stay under 400 words.',
    '- Write in third person — never "I" or "you". Refer to "the operator" and "the role" (or the role\'s name if obvious from context).',
    '- Output the summary directly. Do not preamble ("Here is a summary…") or sign off.',
    '',
    'If the older portion already contains a `## Summary` block from a prior summarisation, treat its bullets as established facts and fold them into the new summary.',
  ].join('\n');

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: resolveChatModel(modelOverride),
      max_tokens: MAX_SUMMARY_TOKENS,
      system: systemPrompt,
      messages: [
        {
          role: 'user',
          content: `Summarise the conversation below.\n\n${transcript}`,
        },
      ],
    });
  } catch (error: unknown) {
    if (error instanceof Anthropic.APIError) {
      throw new AnthropicChatError(
        `Anthropic API error (${error.status ?? 'unknown'}): ${error.message}`,
        error,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new AnthropicChatError(`Anthropic request failed: ${message}`, error);
  }

  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  const text = parts.join('').trim();
  if (text.length === 0) {
    throw new AnthropicChatError('Anthropic returned an empty summary.');
  }
  return text;
}

interface ArchivedFileArgs {
  thread: { thread: ThreadMeta };
  olderTurns: readonly Turn[];
  turnRange: { from: number; to: number };
  archivedAtIso: string;
}

/**
 * Render the on-disk shape for the archived turns file. The frontmatter
 * records where it came from so the audit trail is self-describing without
 * needing the original thread file. Turn bodies are preserved verbatim,
 * including any tool-call fences from `parseTurns` — round-trip identical to
 * what was on disk before summarisation.
 */
function renderArchivedFile(args: ArchivedFileArgs): string {
  const { thread, olderTurns, turnRange, archivedAtIso } = args;
  const fmLines: string[] = [
    '---',
    `archived_from: ${thread.thread.thread_id}`,
    `turn_range: ${turnRange.from}-${turnRange.to}`,
    `archived_at: ${archivedAtIso}`,
    `original_title: ${escapeFrontmatterValue(thread.thread.title)}`,
    `original_created: ${thread.thread.created}`,
    '---',
  ];
  const body = olderTurns.map(renderTurn).join('\n\n');
  return `${fmLines.join('\n')}\n\n${body}\n`;
}

interface RewrittenThreadArgs {
  meta: ThreadMeta;
  summaryTurn: Turn;
  newerTurns: readonly Turn[];
}

/**
 * Render the rewritten thread file: original frontmatter (with `updated`
 * bumped), then a `## Summary · turns N-M · <iso>` synthetic turn, then the
 * newest turns verbatim. The Summary turn round-trips through `parseTurns`
 * as a `role: 'summary'` Turn, and `buildMessages()` translates it into a
 * user-role message with a clear preface when feeding history back to
 * Anthropic.
 */
function renderRewrittenThread(args: RewrittenThreadArgs): string {
  const { meta, summaryTurn, newerTurns } = args;
  const fm = [
    '---',
    `thread_id: ${meta.thread_id}`,
    `title: ${escapeFrontmatterValue(meta.title)}`,
    `created: ${meta.created}`,
    `updated: ${meta.updated}`,
    '---',
  ].join('\n');

  const turnsRendered = [summaryTurn, ...newerTurns].map(renderTurn).join('\n\n');
  return `${fm}\n\n${turnsRendered}\n`;
}

/**
 * Mirror of `conversation.ts`'s private `renderTurn`. Re-implemented here so
 * we don't pollute conversation.ts's public surface — the on-disk shape is
 * stable enough that a tiny duplication is the right trade-off. Handles all
 * three roles (`user`, `assistant`, `summary`).
 */
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

function escapeFrontmatterValue(value: string): string {
  if (/^[A-Za-z0-9 _.,!?;:()\-—–'’"]+$/.test(value) && !value.includes(':')) {
    return value;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}

function fail(message: string): SummariseFailure {
  return { ok: false, error: message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
