import type { Turn } from './conversation.js';

/**
 * Rough character-based token estimator. Anthropic's tokenizer averages ~4
 * chars per token for English prose; we use a `ceil(len / 4)` shortcut that
 * lands within ~10% of a real count. Good enough for the UI's "budget"
 * surface and the threshold check that triggers the "summarise older turns"
 * banner — we'll wire to the official count endpoint if precision matters
 * later (see issue #16 for the deferred follow-up).
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Token estimate split into the system-prompt portion and the conversation
 * history portion. The UI surfaces `total` next to the thread title and uses
 * it for the threshold banner; the breakdown is exposed for debugging or
 * future tooltips.
 */
export interface ThreadTokenEstimate {
  /** Estimated tokens for the system prompt the role sends each turn. */
  systemPrompt: number;
  /** Estimated tokens for all conversation turns combined. */
  history: number;
  /** Sum of `systemPrompt` + `history`. */
  total: number;
}

/**
 * Estimate the per-turn cost of a thread. Mirrors what's actually sent to
 * Anthropic on each turn: the system prompt + every turn's content (tool-call
 * fences are not replayed by `buildMessages` so they're excluded here too).
 */
export function estimateThreadTokens(
  turns: readonly Turn[],
  systemPrompt: string,
): ThreadTokenEstimate {
  const systemTokens = estimateTokens(systemPrompt);
  let historyTokens = 0;
  for (const turn of turns) {
    historyTokens += estimateTokens(turn.content);
  }
  return {
    systemPrompt: systemTokens,
    history: historyTokens,
    total: systemTokens + historyTokens,
  };
}
