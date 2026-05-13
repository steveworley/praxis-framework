import type { APIRoute } from 'astro';

import { hasApiKey } from '@/lib/chat/anthropic.js';
import { loadThread, serializeTurn } from '@/lib/chat/conversation.js';
import { summariseThread } from '@/lib/chat/summarise.js';
import { getRoleHome } from '@/lib/role-home.js';

export const prerender = false;

const THREAD_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Operator-driven summarisation. Folds the older 70% of turns in the thread
 * into a single `## Summary · turns N-M · <iso>` block, moves the originals
 * to `memory/conversations/archived/<thread_id>-turns-N-M-<slug>.md`, and
 * lands a single role-attributed audit commit.
 *
 * Returns the fresh thread record so the client can refresh its transcript
 * without a second round-trip.
 */
export const POST: APIRoute = async ({ params }) => {
  if (!hasApiKey()) {
    return json(503, {
      error: 'ANTHROPIC_API_KEY is not set. The chat surface is disabled.',
    });
  }

  const threadId = params['id'];
  if (typeof threadId !== 'string' || threadId.length === 0) {
    return json(400, { error: 'Missing thread id' });
  }
  if (!THREAD_ID_RE.test(threadId)) {
    return json(400, {
      error: 'thread_id must contain only alphanumeric, dot, dash, or underscore',
    });
  }

  const roleHome = getRoleHome();

  const result = await summariseThread(roleHome, threadId);
  if (!result.ok) {
    // "thread too short to summarise" is a 422 (operator asked for something
    // the input doesn't support); thread-missing is a 404; everything else
    // (Anthropic / IO / git) is a 502. Map by sniffing the error text so we
    // don't have to swap the result envelope to an error-code variant.
    if (/has only \d+ turn/.test(result.error)) {
      return json(422, { error: result.error });
    }
    if (/could not be loaded.*ENOENT/i.test(result.error)) {
      return json(404, { error: result.error });
    }
    return json(502, { error: result.error });
  }

  let refreshed;
  try {
    refreshed = await loadThread(roleHome, threadId);
  } catch (error: unknown) {
    return json(500, {
      error: `Summarised but could not reload the thread: ${errorMessage(error)}`,
      summary: result.summary,
      archivedPath: result.archivedPath,
    });
  }

  const payload: Record<string, unknown> = {
    ok: true,
    thread: refreshed.thread,
    turns: refreshed.turns.map(serializeTurn),
    summary: result.summary,
    archivedPath: result.archivedPath,
    turnRange: result.turnRange,
    tokensBefore: result.tokensBefore,
    tokensAfter: result.tokensAfter,
  };
  if (result.commitSha) payload['commitSha'] = result.commitSha;
  if (result.commitShortSha) payload['commitShortSha'] = result.commitShortSha;
  if (result.commitWarning) payload['commitWarning'] = result.commitWarning;
  return json(200, payload);
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
