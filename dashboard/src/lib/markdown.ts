/**
 * Shared markdown renderer for the dashboard.
 *
 * Backed by `markdown-it` so we get the full CommonMark + GFM grammar
 * (headings, paragraphs, blockquotes, fenced code, tables, ordered/unordered
 * lists, nested lists, horizontal rules, links, strikethrough, etc.) rather
 * than the hand-rolled subset the legacy interior shipped with.
 *
 * Used exclusively on the server:
 *   - Astro components (MemoEntry, FullEscalation) call it directly,
 *   - the `/api/chat/*` routes call it via `serializeTurn` so chat turns are
 *     sent to the Alpine client pre-rendered as HTML (the chat page ships no
 *     markdown renderer to the browser).
 *
 * Safety: `html: false` disables raw HTML inside the source markdown, which
 * is the only path through which model/user content could otherwise inject
 * script tags. We never call `set:html` on anything that hasn't been
 * processed by this renderer, so no DOMPurify pass is required.
 */

import MarkdownIt from 'markdown-it';

const md: MarkdownIt = new MarkdownIt({
  html: false, // never allow raw HTML in user/model content (XSS protection)
  linkify: true, // auto-detect bare URLs and turn them into <a> tags
  breaks: true, // a single newline becomes <br> — matches chat-style markdown
  typographer: false, // no smart quotes / dashes; we render code-heavy content
});

/**
 * Strip framework-internal HTML-comment fences before rendering. The chat
 * surface persists tool-call metadata inside `<!-- praxis:tool_calls ... -->`
 * blocks on assistant turns; the chat API parses these separately to build
 * the `turn.toolCalls` payload. But any OTHER caller reading the same file
 * (notebook, escalation references, output cross-links) would otherwise see
 * the fence rendered as escaped text because `html: false` makes markdown-it
 * escape comments rather than drop them. Strip them centrally here.
 */
const PRAXIS_FENCE_RE = /<!--\s*praxis:[\s\S]*?-->\s*/g;

export function stripPraxisFences(text: string): string {
  return text.replace(PRAXIS_FENCE_RE, '');
}

export function renderMarkdown(text: string): string {
  if (!text) return '';
  return md.render(stripPraxisFences(text));
}

/** Escape a raw string for safe interpolation into HTML attribute / text
 * contexts. Kept here (rather than re-introducing in callers) because the
 * legacy renderer exported it and a couple of callers may still import it. */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
