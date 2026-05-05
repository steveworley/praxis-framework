/**
 * Tiny markdown renderer — paragraph/list/heading + bold + inline code.
 * Mirrors the inline renderer in the legacy interior.html so memory and
 * escalation bodies render the same way in the Astro dashboard.
 */

export function renderMarkdown(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let paragraph: string[] = [];
  let inList = false;

  function inline(s: string): string {
    return escapeHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function flushParagraph(): void {
    if (paragraph.length > 0) {
      out.push('<p>' + paragraph.map(inline).join(' ') + '</p>');
      paragraph = [];
    }
  }
  function closeList(): void {
    if (inList) {
      out.push('</ul>');
      inList = false;
    }
  }

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) {
      flushParagraph();
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      out.push('<h3>' + inline(heading[2] ?? '') + '</h3>');
      continue;
    }
    if (line.startsWith('- ') || line.startsWith('* ')) {
      flushParagraph();
      if (!inList) {
        out.push('<ul>');
        inList = true;
      }
      out.push('<li>' + inline(line.slice(2)) + '</li>');
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return out.join('');
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
