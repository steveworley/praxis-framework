import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { assembleActivity } from './activity-loader.js';

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'praxis-activity-'));
}

async function write(dir: string, rel: string, content: string): Promise<void> {
  const abs = path.join(dir, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf-8');
}

const sample = (n: number) =>
  `{"timestamp":"2026-05-13T07:48:0${n}+10:00","agent":"chat","action":"decision","decision_type":"x"}\n`;

describe('activity-loader glob expansion', () => {
  it('default glob picks up root-level logs/<date>.jsonl', async () => {
    const root = await tmpRoot();
    await write(root, 'logs/2026-05-13.jsonl', sample(1));
    const out = await assembleActivity(root, '**/logs/*.jsonl');
    expect(out).toHaveLength(1);
    expect(out[0]?.decision_type).toBe('x');
  });

  it('default glob picks up single-segment <wp>/logs/<date>.jsonl', async () => {
    const root = await tmpRoot();
    await write(root, 'output/logs/2026-05-13.jsonl', sample(2));
    const out = await assembleActivity(root, '**/logs/*.jsonl');
    expect(out).toHaveLength(1);
  });

  it('default glob picks up Sam-style nested <wp>/<id>/logs/<date>.jsonl', async () => {
    const root = await tmpRoot();
    await write(root, 'campaigns/q1-outreach/logs/2026-05-13.jsonl', sample(3));
    const out = await assembleActivity(root, '**/logs/*.jsonl');
    expect(out).toHaveLength(1);
  });

  it('default glob unifies all three shapes in one feed', async () => {
    const root = await tmpRoot();
    await write(root, 'logs/2026-05-13.jsonl', sample(1));
    await write(root, 'output/logs/2026-05-13.jsonl', sample(2));
    await write(root, 'campaigns/q1/logs/2026-05-13.jsonl', sample(3));
    const out = await assembleActivity(root, '**/logs/*.jsonl');
    expect(out).toHaveLength(3);
  });

  it('skips dotfile directories during globstar descent', async () => {
    const root = await tmpRoot();
    await write(root, '.git/logs/HEAD', 'not jsonl');
    await write(root, 'logs/2026-05-13.jsonl', sample(1));
    const out = await assembleActivity(root, '**/logs/*.jsonl');
    expect(out).toHaveLength(1);
  });
});
