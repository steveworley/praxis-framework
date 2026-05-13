import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { APIRoute } from 'astro';

import { getRoleHome } from '@/lib/role-home.js';

export const prerender = false;

const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB

export const POST: APIRoute = async ({ request }) => {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return json(400, { error: 'Expected multipart/form-data body' });
  }

  const threadIdField = form.get('thread_id');
  const fileField = form.get('file');

  if (typeof threadIdField !== 'string' || threadIdField.length === 0) {
    return json(400, { error: 'thread_id is required' });
  }
  if (!isSafeThreadId(threadIdField)) {
    return json(400, { error: 'Invalid thread_id' });
  }
  if (!(fileField instanceof File)) {
    return json(400, { error: 'file is required' });
  }
  if (fileField.size === 0) {
    return json(400, { error: 'File is empty' });
  }
  if (fileField.size > MAX_UPLOAD_SIZE) {
    return json(413, { error: `File exceeds the ${MAX_UPLOAD_SIZE} byte cap` });
  }

  const safeName = sanitiseFilename(fileField.name);
  if (!safeName) {
    return json(400, { error: 'Invalid filename' });
  }

  const roleHome = getRoleHome();
  const uploadsDir = path.join(roleHome, 'lib', 'uploads', threadIdField);
  await fs.mkdir(uploadsDir, { recursive: true });

  const finalName = await pickAvailableName(uploadsDir, safeName);
  const absPath = path.join(uploadsDir, finalName);
  const buffer = Buffer.from(await fileField.arrayBuffer());
  await fs.writeFile(absPath, buffer);

  return json(200, {
    path: path.posix.join('lib', 'uploads', threadIdField, finalName),
    filename: finalName,
    size: buffer.length,
    mime_type: fileField.type || 'application/octet-stream',
  });
};

function isSafeThreadId(threadId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(threadId) && !threadId.includes('..');
}

/**
 * Strip path components and any character that isn't safe in a filename.
 * Returns null if nothing recognisable is left.
 */
function sanitiseFilename(input: string): string | null {
  const base = path.basename(input);
  if (!base || base === '.' || base === '..') return null;
  if (base.includes('/') || base.includes('\\')) return null;
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '');
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return null;
  return cleaned.slice(0, 200);
}

/**
 * If a file with the same name already exists in `dir`, append a short random
 * suffix to disambiguate. Operators can rename later if needed.
 */
async function pickAvailableName(dir: string, name: string): Promise<string> {
  try {
    await fs.access(path.join(dir, name));
  } catch {
    return name;
  }
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  const suffix = randomBytes(3).toString('hex');
  return `${stem}-${suffix}${ext}`;
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
