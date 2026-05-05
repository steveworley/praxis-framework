import fs from 'node:fs/promises';
import path from 'node:path';

import { extractTitle, parseFrontmatter } from './frontmatter.ts';

export interface MemoryEntry {
  category: string;
  slug: string;
  path: string;
  title: string;
  created: string | null;
  updated: string | null;
  body: string;
  frontmatter: Record<string, string>;
}

/**
 * Walk memory/**\/*.md, parse each file (optional frontmatter, first-H1 title),
 * and return entries sorted by `updated` desc with file mtime fallback.
 * The top-level memory/README.md is skipped.
 */
export async function assembleMemory(roleHome: string): Promise<MemoryEntry[]> {
  const memoryRoot = path.join(roleHome, 'memory');
  if (!(await pathExists(memoryRoot))) return [];

  const mdPaths = await walkMarkdown(memoryRoot);
  const entries: MemoryEntry[] = [];
  for (const mdPath of mdPaths.sort()) {
    if (
      path.basename(mdPath).toLowerCase() === 'readme.md' &&
      path.dirname(mdPath) === memoryRoot
    ) {
      continue;
    }
    const entry = await parseMemoryFile(mdPath, memoryRoot);
    if (entry) entries.push(entry);
  }

  entries.sort((a, b) => {
    const ax = a.updated ?? '';
    const bx = b.updated ?? '';
    return bx.localeCompare(ax);
  });
  return entries;
}

async function parseMemoryFile(filePath: string, memoryRoot: string): Promise<MemoryEntry | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }

  const { frontmatter, body } = parseFrontmatter(text);
  const stem = path.basename(filePath, path.extname(filePath));
  const title = extractTitle(body, stem);

  let mtimeIso: string | null = null;
  try {
    const stat = await fs.stat(filePath);
    mtimeIso = stat.mtime.toISOString().slice(0, 10);
  } catch {
    mtimeIso = null;
  }

  const rel = path.relative(memoryRoot, filePath);
  const parts = rel.split(path.sep);
  const category = parts.length > 1 ? (parts[0] ?? 'notes') : 'notes';

  const created = frontmatter['created'] ?? null;
  const fmUpdated = frontmatter['updated'] ?? null;
  const updated = fmUpdated ?? created ?? mtimeIso;

  return {
    category,
    slug: stem,
    path: rel,
    title,
    created,
    updated,
    body: body.trim(),
    frontmatter,
  };
}

async function walkMarkdown(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) continue;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        out.push(full);
      }
    }
  }
  return out;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
