import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { APIRoute } from 'astro';
import { z } from 'zod';

import { getRoleHome } from '@/lib/role-home.js';

export const prerender = false;

const MAX_UPLOAD_SIZE = 5 * 1024 * 1024; // 5 MB

const UploadBody = z.object({
  thread_id: z.string().trim().min(1),
  filename: z.string().trim().min(1),
  mime_type: z.string().trim().optional(),
  data: z.string().min(1), // base64-encoded file bytes
});

export const POST: APIRoute = async ({ request }) => {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const parsed = UploadBody.safeParse(body);
  if (!parsed.success) {
    return json(422, { error: 'Validation failed', issues: parsed.error.issues });
  }

  if (!isSafeThreadId(parsed.data.thread_id)) {
    return json(400, { error: 'Invalid thread_id' });
  }

  const buffer = decodeBase64(parsed.data.data);
  if (buffer.length === 0) {
    return json(400, { error: 'File is empty' });
  }
  if (buffer.length > MAX_UPLOAD_SIZE) {
    return json(413, { error: `File exceeds the ${MAX_UPLOAD_SIZE} byte cap` });
  }

  const safeName = sanitiseFilename(parsed.data.filename);
  if (!safeName) {
    return json(400, { error: 'Invalid filename' });
  }

  const roleHome = getRoleHome();
  const uploadsDir = path.join(roleHome, 'lib', 'uploads', parsed.data.thread_id);
  await fs.mkdir(uploadsDir, { recursive: true });

  const finalName = await pickAvailableName(uploadsDir, safeName);
  const absPath = path.join(uploadsDir, finalName);
  await fs.writeFile(absPath, buffer);

  return json(200, {
    path: path.posix.join('lib', 'uploads', parsed.data.thread_id, finalName),
    filename: finalName,
    size: buffer.length,
    mime_type: parsed.data.mime_type || 'application/octet-stream',
  });
};

/**
 * Decode base64 file bytes. The browser sends raw base64, but defensively
 * strip an accidental `data:<mime>;base64,` prefix since Buffer.from tolerates
 * it poorly.
 */
function decodeBase64(input: string): Buffer {
  const commaIndex = input.indexOf(',');
  const payload =
    commaIndex >= 0 && input.startsWith('data:') ? input.slice(commaIndex + 1) : input;
  return Buffer.from(payload, 'base64');
}

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
