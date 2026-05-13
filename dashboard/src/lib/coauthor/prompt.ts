import type { EscalationDetail } from '@/lib/triage.js';

/**
 * Build the system + user payload for the co-authoring drafting call. The
 * model's job is narrow: produce the *complete* new file content that applies
 * the operator's directive, framed by the escalation that motivated it.
 *
 * Returns a single string we pass as the user content of a single-turn
 * `sendMessage` call. The system prompt is also a single block — co-authoring
 * is a one-shot drafting task, no tool use, no multi-turn conversation.
 */
export interface BuildPromptOptions {
  escalation: EscalationDetail;
  target_path: string;
  current_content: string;
  directive: string;
}

export interface BuiltPrompt {
  system: string;
  user: string;
}

export function buildCoauthorPrompt(opts: BuildPromptOptions): BuiltPrompt {
  const system = [
    `You are helping the operator apply a constitutional change to ${opts.target_path}. The role filed the escalation below. The operator has accepted it and wants you to draft the specific text change.`,
    '',
    'Output ONLY the new full file content. No commentary, no diff, no markdown fences around the file body — just the file. Preserve frontmatter, structure, and any parts that do not need to change. Make the smallest edit that satisfies the directive.',
  ].join('\n');

  const user = [
    '## Escalation that motivated this change',
    '',
    `- id: ${opts.escalation.id}`,
    `- kind: ${opts.escalation.kind}`,
    `- urgency: ${opts.escalation.urgency}`,
    `- title: ${opts.escalation.title}`,
    '',
    opts.escalation.body.trim(),
    '',
    '## Current file',
    '',
    `Path: ${opts.target_path}`,
    '',
    '```',
    opts.current_content,
    '```',
    '',
    "## Operator's directive",
    '',
    opts.directive.trim(),
    '',
    '## Your output',
    '',
    'Return the complete new file content. Begin your response on the first line with the new file. Do not wrap it in markdown fences. Do not prepend or append commentary. Preserve any existing YAML frontmatter unless the directive explicitly asks for it to change.',
  ].join('\n');

  return { system, user };
}

/**
 * Strip the defensive cases where a model wraps the requested file in a
 * fenced block, prepends an explanation, or echoes "Here's the file:".
 * The drafting prompt asks for raw file content, but models occasionally
 * over-cooperate; this peeling logic is intentionally narrow so we don't
 * mangle legitimate output.
 */
export function extractFileContent(modelOutput: string): string {
  let text = modelOutput.trimEnd();
  // Pull out the first fenced block if the entire response is one.
  const fenceMatch = /^\s*```(?:[a-z0-9_+\-]+)?\s*\n([\s\S]*?)\n```\s*$/.exec(text);
  if (fenceMatch) {
    text = fenceMatch[1] ?? '';
  }
  // Strip a single leading "Here is..." preamble line if the next blank-line
  // separated chunk obviously starts the file (frontmatter `---` or a heading).
  const preambleMatch = /^[ \t]*(?:here['’]?s|here is|sure[,.]?)[^\n]{0,160}\n+/i.exec(text);
  if (preambleMatch) {
    const rest = text.slice(preambleMatch[0].length);
    if (/^(?:---|#\s|[A-Za-z0-9_\-])/m.test(rest)) {
      text = rest;
    }
  }
  return text.replace(/^\n+/, '');
}
