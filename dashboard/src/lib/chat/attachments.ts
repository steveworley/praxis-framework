import fs from 'node:fs/promises';
import path from 'node:path';

import type { AttachmentSupport, ContentBlock } from '@praxis-framework/inference';

/**
 * Resolver that turns a list of uploaded attachment paths into model-facing
 * content. Small text-shaped files are inlined into the prompt text; images
 * and documents the configured backend can read natively become base64
 * `image`/`document` blocks; anything else (or a backend that can't read the
 * type) is surfaced as a short refusal note so the model knows the file
 * exists but couldn't be opened.
 */

const MAX_ATTACHMENT_SIZE = 10 * 1024; // 10 KB — inline only short text uploads.

/**
 * Extensions we'll read and splice directly into the prompt text regardless of
 * provider capability — they're plain text the model can always parse.
 */
const TEXTUAL_EXTENSIONS = new Set<string>([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.csv',
  '.tsv',
  '.log',
]);

/**
 * Extension → MIME mapping used to classify non-textual uploads against the
 * provider's native attachment support. Kept small + dependency-free; the
 * universal textual extensions above are handled before we ever consult this.
 */
const EXTENSION_MIME: Record<string, string> = {
  // images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  // documents
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.txt': 'text/plain',
};

export interface BuiltUserContent {
  /**
   * Model-facing content. A plain string when no native blocks were produced
   * (back-compat text path), or a text block followed by image/document blocks
   * when at least one attachment was attached natively.
   */
  content: string | ContentBlock[];
  /**
   * Storage + UI echo text. Never contains file bodies or base64 — only the
   * user's text, an `Attached: …` filename line, and any refusal/missing notes.
   */
  persistedText: string;
}

/**
 * Whether a relative attachment path is safe to read. Attachments live under
 * `lib/uploads/<thread_id>/`; we reject absolute paths, parent-directory
 * traversal, and anything outside that prefix to keep the surface narrow.
 */
export function isSafeAttachmentPath(rel: string): boolean {
  if (rel.length === 0) return false;
  if (rel.includes('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return rel.startsWith('lib/uploads/');
}

/**
 * Build the model-facing content + persisted echo text for a turn that may
 * carry attachments. See `BuiltUserContent` for the two outputs.
 */
export async function buildUserContent(
  roleHome: string,
  userText: string,
  attachmentPaths: string[],
  support: AttachmentSupport,
): Promise<BuiltUserContent> {
  // Text pieces spliced into the prompt body (user text + inlined small files).
  const inlineTextPieces: string[] = [];
  // Image/document blocks the provider can read natively.
  const blocks: ContentBlock[] = [];
  // Notes echoed to the operator + sent to the model (refusals, missing files).
  const notes: string[] = [];
  // Filenames for the `Attached: …` echo line.
  const filenames: string[] = [];

  for (const rel of attachmentPaths) {
    if (!isSafeAttachmentPath(rel)) {
      notes.push(`[Attachment refused — unsafe path: ${rel}]`);
      continue;
    }

    const abs = path.join(roleHome, rel);
    const filename = path.basename(rel);
    const ext = path.extname(filename).toLowerCase();

    let stat;
    try {
      stat = await fs.stat(abs);
    } catch {
      notes.push(`[Attachment missing: ${filename}]`);
      continue;
    }

    filenames.push(filename);

    // 1. text-like + small → inline into the prompt body (universal).
    if (TEXTUAL_EXTENSIONS.has(ext) && stat.size <= MAX_ATTACHMENT_SIZE) {
      try {
        const text = await fs.readFile(abs, 'utf-8');
        inlineTextPieces.push(`--- Attachment: ${filename} ---\n${text}\n--- end attachment ---`);
      } catch {
        notes.push(`[Attachment unreadable: ${filename}]`);
      }
      continue;
    }

    const mime = EXTENSION_MIME[ext];
    if (!mime) {
      notes.push(`[Attachment "${filename}" — this inference backend can't read ${ext} files]`);
      continue;
    }

    // 2. image MIME the backend reads natively → image block.
    if (support.images.includes(mime)) {
      const data = await readBase64(abs);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data } });
      continue;
    }

    // 3. document MIME the backend reads natively → document block.
    if (support.documents.includes(mime)) {
      const data = await readBase64(abs);
      blocks.push({
        type: 'document',
        source: { type: 'base64', media_type: mime, data },
        name: filename,
      });
      continue;
    }

    // 4. backend can't read this type → refusal note.
    notes.push(`[Attachment "${filename}" — this inference backend can't read ${ext} files]`);
  }

  const textParts = [userText, ...inlineTextPieces, ...notes].filter((p) => p.length > 0);
  const promptText = textParts.join('\n\n');

  const content: string | ContentBlock[] =
    blocks.length > 0 ? [{ type: 'text', text: promptText }, ...blocks] : promptText;

  const persistedParts = [userText];
  if (filenames.length > 0) {
    persistedParts.push(`Attached: ${filenames.join(', ')}`);
  }
  persistedParts.push(...notes);
  const persistedText = persistedParts.filter((p) => p.length > 0).join('\n\n');

  return { content, persistedText };
}

async function readBase64(abs: string): Promise<string> {
  const buffer = await fs.readFile(abs);
  return buffer.toString('base64');
}
