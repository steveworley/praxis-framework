import fs from 'node:fs/promises';
import path from 'node:path';

export interface ActivityEntry {
  timestamp?: string;
  action?: string;
  agent?: string;
  headline?: string;
  notes?: string;
  _log_path: string;
  [key: string]: unknown;
}

/**
 * Walk the configured log glob rooted at the role home. Each line of each
 * .jsonl is one activity entry. Sort by timestamp desc, slice to limit.
 *
 * Glob support: top-level segments may use `*` (matches any directory at that
 * depth) or be literal. Filename pattern supports `*` prefixes/suffixes.
 * Mirrors the default `*\/logs/*.jsonl` shape used by the Python server.
 */
export async function assembleActivity(
  roleHome: string,
  logGlob: string,
  limit: number,
): Promise<ActivityEntry[]> {
  const matches = await expandGlob(roleHome, logGlob);
  const entries: ActivityEntry[] = [];

  for (const filePath of matches) {
    let text: string;
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) continue;
      text = await fs.readFile(filePath, 'utf-8');
    } catch {
      continue;
    }
    const rel = path.relative(roleHome, filePath);
    for (const rawLine of text.split('\n')) {
      const line = rawLine.trim();
      if (line.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const entry: ActivityEntry = { ...(parsed as Record<string, unknown>), _log_path: rel };
      entries.push(entry);
    }
  }

  entries.sort((a, b) => {
    const at = a.timestamp ?? '';
    const bt = b.timestamp ?? '';
    return bt.localeCompare(at);
  });

  return entries.slice(0, limit);
}

async function expandGlob(root: string, pattern: string): Promise<string[]> {
  const segments = pattern.split('/').filter((s) => s.length > 0);
  let layers: string[] = [path.resolve(root)];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    const isLast = i === segments.length - 1;
    const next: string[] = [];
    for (const dir of layers) {
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!segmentMatches(entry.name, segment)) continue;
        const full = path.join(dir, entry.name);
        if (isLast) {
          if (entry.isFile()) next.push(full);
        } else {
          if (entry.isDirectory()) next.push(full);
        }
      }
    }
    layers = next;
  }
  return layers;
}

function segmentMatches(name: string, pattern: string): boolean {
  if (pattern === '*') return !name.startsWith('.');
  if (!pattern.includes('*')) return name === pattern;
  // Convert *foo* / *foo / foo* shapes to a regex.
  const re = new RegExp(
    '^' +
      pattern
        .split('*')
        .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*') +
      '$',
  );
  return re.test(name);
}
