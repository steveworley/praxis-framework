import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AttachmentSupport, ContentBlock } from '@praxis-framework/inference';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildUserContent, isSafeAttachmentPath } from './attachments.ts';

// Provider-shaped attachment support fixtures mirroring the two real providers.
const ANTHROPIC_SUPPORT: AttachmentSupport = {
  images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  documents: ['application/pdf'],
};
const QUANT_SUPPORT: AttachmentSupport = {
  images: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'],
  documents: [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/markdown',
    'text/csv',
    'text/html',
    'text/plain',
  ],
};

let roleHome: string;

beforeEach(async () => {
  roleHome = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-attachments-'));
});

afterEach(async () => {
  await fs.rm(roleHome, { recursive: true, force: true });
});

/**
 * Write a fixture file under the role's `lib/uploads/<thread>/` tree and return
 * the relative path the resolver expects.
 */
async function writeUpload(name: string, data: string | Buffer, thread = 'thread-1'): Promise<string> {
  const dir = path.join(roleHome, 'lib', 'uploads', thread);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), data);
  return path.posix.join('lib', 'uploads', thread, name);
}

function isBlocks(content: string | ContentBlock[]): content is ContentBlock[] {
  return Array.isArray(content);
}

describe('isSafeAttachmentPath', () => {
  it('accepts paths under lib/uploads/', () => {
    expect(isSafeAttachmentPath('lib/uploads/thread-1/file.txt')).toBe(true);
  });

  it('rejects traversal, absolute, empty, and out-of-prefix paths', () => {
    expect(isSafeAttachmentPath('lib/uploads/../../etc/passwd')).toBe(false);
    expect(isSafeAttachmentPath('/etc/passwd')).toBe(false);
    expect(isSafeAttachmentPath('')).toBe(false);
    expect(isSafeAttachmentPath('memory/secret.md')).toBe(false);
  });
});

describe('buildUserContent', () => {
  it('returns a plain string when there are no attachments', async () => {
    const { content, persistedText } = await buildUserContent(roleHome, 'hello there', [], ANTHROPIC_SUPPORT);
    expect(content).toBe('hello there');
    expect(typeof content).toBe('string');
    expect(persistedText).toBe('hello there');
  });

  it('inlines small text files into the prompt body with the marker format', async () => {
    const rel = await writeUpload('notes.txt', 'line one\nline two');
    const { content, persistedText } = await buildUserContent(roleHome, 'read this', [rel], ANTHROPIC_SUPPORT);

    expect(typeof content).toBe('string');
    expect(content).toContain('read this');
    expect(content).toContain('--- Attachment: notes.txt ---');
    expect(content).toContain('line one\nline two');
    expect(content).toContain('--- end attachment ---');

    // Persisted echo references the filename but never the body.
    expect(persistedText).toContain('Attached: notes.txt');
    expect(persistedText).not.toContain('line one');
  });

  it('produces an image block for a supported image type', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const rel = await writeUpload('shot.png', bytes);
    const { content } = await buildUserContent(roleHome, 'look', [rel], ANTHROPIC_SUPPORT);

    expect(isBlocks(content)).toBe(true);
    if (!isBlocks(content)) throw new Error('expected blocks');
    expect(content[0]).toEqual({ type: 'text', text: 'look' });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: bytes.toString('base64') },
    });
  });

  it('produces a document block for a supported pdf', async () => {
    const bytes = Buffer.from('%PDF-1.4 fake');
    const rel = await writeUpload('report.pdf', bytes);
    const { content } = await buildUserContent(roleHome, 'summarise', [rel], ANTHROPIC_SUPPORT);

    expect(isBlocks(content)).toBe(true);
    if (!isBlocks(content)) throw new Error('expected blocks');
    expect(content[1]).toEqual({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: bytes.toString('base64') },
      name: 'report.pdf',
    });
  });

  it('refuses a docx under Anthropic-style support (pdf-only documents)', async () => {
    const rel = await writeUpload('memo.docx', Buffer.from('PK fake docx'));
    const { content, persistedText } = await buildUserContent(roleHome, 'open this', [rel], ANTHROPIC_SUPPORT);

    expect(typeof content).toBe('string');
    expect(content).toContain("[Attachment \"memo.docx\" — this inference backend can't read .docx files]");
    expect(persistedText).toContain("can't read .docx files");
  });

  it('attaches a docx as a document block under Quant-style support', async () => {
    const bytes = Buffer.from('PK fake docx');
    const rel = await writeUpload('memo.docx', bytes);
    const { content } = await buildUserContent(roleHome, 'open this', [rel], QUANT_SUPPORT);

    expect(isBlocks(content)).toBe(true);
    if (!isBlocks(content)) throw new Error('expected blocks');
    expect(content[1]).toEqual({
      type: 'document',
      source: {
        type: 'base64',
        media_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        data: bytes.toString('base64'),
      },
      name: 'memo.docx',
    });
  });

  it('notes a missing file by filename', async () => {
    const rel = path.posix.join('lib', 'uploads', 'thread-1', 'gone.pdf');
    const { content, persistedText } = await buildUserContent(roleHome, 'where is it', [rel], ANTHROPIC_SUPPORT);

    expect(typeof content).toBe('string');
    expect(content).toContain('[Attachment missing: gone.pdf]');
    expect(persistedText).toContain('[Attachment missing: gone.pdf]');
  });

  it('notes an unsafe path without reading it', async () => {
    const { content } = await buildUserContent(roleHome, 'sneaky', ['../../etc/passwd'], ANTHROPIC_SUPPORT);
    expect(typeof content).toBe('string');
    expect(content).toContain('[Attachment refused — unsafe path: ../../etc/passwd]');
  });

  it('never includes base64 in persistedText for a native block', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xee]);
    const rel = await writeUpload('shot.png', bytes);
    const { persistedText } = await buildUserContent(roleHome, 'look', [rel], ANTHROPIC_SUPPORT);

    expect(persistedText).toContain('Attached: shot.png');
    expect(persistedText).not.toContain(bytes.toString('base64'));
  });
});
