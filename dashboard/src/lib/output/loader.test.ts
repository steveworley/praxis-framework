import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OutputNotFoundError,
  OutputValidationError,
  listOutputs,
  loadOutput,
} from './loader.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-output-loader-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
  // Seed an output/ subtree with one of each type.
  await fs.mkdir(path.join(tempDir, 'output/document'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'output/draft'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'output/record/account/acme'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'output/plan'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'output/reference'), { recursive: true });

  await fs.writeFile(
    path.join(tempDir, 'output/document/q1-brief.md'),
    [
      '---',
      'type: document',
      'slug: q1-brief',
      'status: ready',
      "title: 'Q1 brief: shipping plan'",
      'created: 2026-05-01T10:00:00+10:00',
      'updated: 2026-05-02T11:00:00+10:00',
      '---',
      '',
      'The body.',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(tempDir, 'output/draft/cold-mary.md'),
    [
      '---',
      'type: draft',
      'slug: cold-mary',
      'status: draft',
      'recipient: mary@acme.com',
      'channel: email',
      "subject: 'Quick question for you'",
      'created: 2026-05-13T08:00:00+10:00',
      'updated: 2026-05-13T08:00:00+10:00',
      '---',
      '',
      'Hi Mary,',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(tempDir, 'output/record/account/acme/2026-q1-read.md'),
    [
      '---',
      'type: record',
      'slug: 2026-q1-read',
      'status: done',
      'entity_type: account',
      'entity_id: acme',
      'observed_at: 2026-04-28',
      'created: 2026-04-28T15:00:00+10:00',
      'updated: 2026-04-28T15:00:00+10:00',
      '---',
      '',
      'Account read.',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(tempDir, 'output/plan/land-acme.md'),
    [
      '---',
      'type: plan',
      'slug: land-acme',
      'status: draft',
      "goal: 'Land Acme contract'",
      'owner: sam',
      'created: 2026-05-10T09:00:00+10:00',
      'updated: 2026-05-10T09:00:00+10:00',
      '---',
      '',
      '- [x] Intro call',
      '- [ ] Pricing alignment',
      '- [ ] Decision',
    ].join('\n'),
    'utf-8',
  );
  await fs.writeFile(
    path.join(tempDir, 'output/reference/pricing-objections.md'),
    [
      '---',
      'type: reference',
      'slug: pricing-objections',
      'status: ready',
      'topic: pricing objection patterns',
      "tags: [pricing, objections]",
      'created: 2026-03-01T12:00:00+10:00',
      'updated: 2026-03-01T12:00:00+10:00',
      '---',
      '',
      'Two patterns we see.',
    ].join('\n'),
    'utf-8',
  );
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('listOutputs', () => {
  it('returns all five seeded entries when called without filters', async () => {
    const all = await listOutputs(tempDir);
    expect(all).toHaveLength(5);
    const types = all.map((e) => e.type).sort();
    expect(types).toEqual(['document', 'draft', 'plan', 'record', 'reference']);
  });

  it('sorts by `updated` desc', async () => {
    const all = await listOutputs(tempDir);
    for (let i = 1; i < all.length; i += 1) {
      const prev = all[i - 1];
      const curr = all[i];
      if (!prev || !curr) continue;
      expect(prev.updated >= curr.updated).toBe(true);
    }
  });

  it('filters by type', async () => {
    const onlyDrafts = await listOutputs(tempDir, { type: 'draft' });
    expect(onlyDrafts).toHaveLength(1);
    expect(onlyDrafts[0]?.slug).toBe('cold-mary');
  });

  it('filters by status', async () => {
    const ready = await listOutputs(tempDir, { status: 'ready' });
    expect(ready.map((e) => e.slug).sort()).toEqual(['pricing-objections', 'q1-brief']);
  });

  it('filters records by entity_type/entity_id', async () => {
    const acme = await listOutputs(tempDir, {
      type: 'record',
      entityType: 'account',
      entityId: 'acme',
    });
    expect(acme).toHaveLength(1);
    expect(acme[0]?.slug).toBe('2026-q1-read');

    const missing = await listOutputs(tempDir, {
      type: 'record',
      entityType: 'account',
      entityId: 'not-here',
    });
    expect(missing).toEqual([]);
  });

  it('honours limit', async () => {
    const two = await listOutputs(tempDir, { limit: 2 });
    expect(two).toHaveLength(2);
  });

  it('returns derived titles per type', async () => {
    const docs = await listOutputs(tempDir, { type: 'document' });
    expect(docs[0]?.title).toBe('Q1 brief: shipping plan');
    const drafts = await listOutputs(tempDir, { type: 'draft' });
    expect(drafts[0]?.title).toBe('Quick question for you');
    const plans = await listOutputs(tempDir, { type: 'plan' });
    expect(plans[0]?.title).toBe('Land Acme contract');
    const refs = await listOutputs(tempDir, { type: 'reference' });
    expect(refs[0]?.title).toBe('pricing objection patterns');
  });

  it('parses reference tags into an array', async () => {
    const refs = await listOutputs(tempDir, { type: 'reference' });
    expect(refs[0]?.extras['tags']).toEqual(['pricing', 'objections']);
  });

  it('skips files whose type frontmatter disagrees with the directory', async () => {
    await fs.writeFile(
      path.join(tempDir, 'output/document/imposter.md'),
      ['---', 'type: draft', 'slug: imposter', 'status: draft', '---', '', 'body'].join('\n'),
      'utf-8',
    );
    const docs = await listOutputs(tempDir, { type: 'document' });
    expect(docs.find((e) => e.slug === 'imposter')).toBeUndefined();
  });
});

describe('loadOutput', () => {
  it('loads single-segment outputs', async () => {
    const detail = await loadOutput(tempDir, 'document', 'q1-brief');
    expect(detail.meta.slug).toBe('q1-brief');
    expect(detail.meta.status).toBe('ready');
    expect(detail.body.trim()).toBe('The body.');
  });

  it('loads record outputs from multi-segment slug', async () => {
    const detail = await loadOutput(tempDir, 'record', 'account/acme/2026-q1-read');
    expect(detail.meta.slug).toBe('2026-q1-read');
    expect(detail.meta.extras['entity_type']).toBe('account');
    expect(detail.meta.extras['entity_id']).toBe('acme');
  });

  it('throws OutputNotFoundError on missing files', async () => {
    await expect(loadOutput(tempDir, 'document', 'nope')).rejects.toBeInstanceOf(
      OutputNotFoundError,
    );
  });

  it('throws OutputValidationError on path traversal', async () => {
    await expect(loadOutput(tempDir, 'document', '../escape')).rejects.toBeInstanceOf(
      OutputValidationError,
    );
  });

  it('throws OutputValidationError on wrong segment count for record', async () => {
    await expect(loadOutput(tempDir, 'record', 'just-one')).rejects.toBeInstanceOf(
      OutputValidationError,
    );
  });

  it('throws OutputValidationError on multi-segment for non-record', async () => {
    await expect(loadOutput(tempDir, 'document', 'a/b/c')).rejects.toBeInstanceOf(
      OutputValidationError,
    );
  });
});
