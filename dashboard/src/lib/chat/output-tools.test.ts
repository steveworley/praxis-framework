import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  executeUpdateOutputStatus,
  executeWriteOutput,
} from './output-tools.js';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-output-tools-'));
  await fs.writeFile(path.join(tempDir, 'persona.md'), '# Persona\n', 'utf-8');
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe('executeWriteOutput', () => {
  it('refuses on invalid input shape', async () => {
    const r = await executeWriteOutput(tempDir, { type: 'document' });
    expect(r.ok).toBe(false);
  });

  it('refuses on unknown type', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'meme',
      slug: 'x',
      body: 'y',
    });
    expect(r.ok).toBe(false);
  });

  it('writes a document with required title field', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'document',
      slug: 'q1-brief',
      body: '# Q1 brief\n\nThe body.',
      fields: { title: 'Q1 brief' },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('output/document/q1-brief.md');
    expect(r.data['status']).toBe('draft');

    const written = await fs.readFile(
      path.join(tempDir, 'output/document/q1-brief.md'),
      'utf-8',
    );
    expect(written).toMatch(/^---\n/);
    expect(written).toMatch(/type: document/);
    expect(written).toMatch(/slug: q1-brief/);
    expect(written).toMatch(/status: draft/);
    expect(written).toMatch(/title: Q1 brief/);
    expect(written).toContain('The body.');
  });

  it('refuses to overwrite an existing file', async () => {
    await executeWriteOutput(tempDir, {
      type: 'document',
      slug: 'q1',
      body: 'first',
      fields: { title: 'q1' },
    });
    const r = await executeWriteOutput(tempDir, {
      type: 'document',
      slug: 'q1',
      body: 'second',
      fields: { title: 'q1' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/already exists/);
  });

  it('refuses when required field is missing (document.title)', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'document',
      slug: 'q1',
      body: 'body',
      fields: {},
    });
    expect(r.ok).toBe(false);
  });

  it('writes a draft with optional channel + recipient', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'draft',
      slug: 'cold-mary',
      body: 'Hi Mary,',
      fields: {
        recipient: 'mary@acme.com',
        channel: 'email',
        subject: 'Quick question for you',
      },
    });
    expect(r.ok).toBe(true);
    const written = await fs.readFile(
      path.join(tempDir, 'output/draft/cold-mary.md'),
      'utf-8',
    );
    expect(written).toMatch(/recipient: mary@acme\.com/);
    expect(written).toMatch(/channel: email/);
  });

  it('refuses draft with invalid channel enum', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'draft',
      slug: 'cold-mary',
      body: 'Hi Mary,',
      fields: { channel: 'fax' },
    });
    expect(r.ok).toBe(false);
  });

  it('writes a record into the entity-scoped subdir', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'record',
      slug: 'q1-read',
      body: 'Account read.',
      fields: {
        entity_type: 'account',
        entity_id: 'acme',
        observed_at: '2026-04-28',
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['path']).toBe('output/record/account/acme/q1-read.md');
    const exists = await fs.stat(
      path.join(tempDir, 'output/record/account/acme/q1-read.md'),
    );
    expect(exists.isFile()).toBe(true);
  });

  it('refuses record with missing entity_type', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'record',
      slug: 'note',
      body: 'x',
      fields: { entity_id: 'acme', observed_at: '2026-01-01' },
    });
    expect(r.ok).toBe(false);
  });

  it('refuses a malformed slug (path traversal)', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'document',
      slug: '../escape',
      body: 'x',
      fields: { title: 'x' },
    });
    expect(r.ok).toBe(false);
  });

  it('writes a plan with checklist body and goal field', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'plan',
      slug: 'land-acme',
      body: '- [ ] Intro\n- [ ] Pricing\n- [ ] Decision',
      fields: { goal: 'Land Acme contract' },
    });
    expect(r.ok).toBe(true);
    const written = await fs.readFile(
      path.join(tempDir, 'output/plan/land-acme.md'),
      'utf-8',
    );
    expect(written).toMatch(/goal: Land Acme contract/);
    expect(written).toContain('- [ ] Pricing');
  });

  it('writes a reference with tags array as inline YAML', async () => {
    const r = await executeWriteOutput(tempDir, {
      type: 'reference',
      slug: 'pricing-objections',
      body: 'Patterns.',
      fields: { topic: 'pricing objection patterns', tags: ['pricing', 'objections'] },
    });
    expect(r.ok).toBe(true);
    const written = await fs.readFile(
      path.join(tempDir, 'output/reference/pricing-objections.md'),
      'utf-8',
    );
    expect(written).toMatch(/tags: \[pricing, objections\]/);
  });
});

describe('executeUpdateOutputStatus', () => {
  it('refuses when the file does not exist', async () => {
    const r = await executeUpdateOutputStatus(tempDir, {
      type: 'document',
      slug: 'nope',
      status: 'sent',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/does not exist/);
  });

  it('refuses on invalid status enum', async () => {
    const r = await executeUpdateOutputStatus(tempDir, {
      type: 'document',
      slug: 'q1',
      status: 'rejected',
    });
    expect(r.ok).toBe(false);
  });

  it('updates an existing file from draft to sent', async () => {
    await executeWriteOutput(tempDir, {
      type: 'draft',
      slug: 'cold-mary',
      body: 'Hi Mary,',
      fields: { channel: 'email' },
    });

    const r = await executeUpdateOutputStatus(tempDir, {
      type: 'draft',
      slug: 'cold-mary',
      status: 'sent',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['previous_status']).toBe('draft');
    expect(r.data['status']).toBe('sent');

    const written = await fs.readFile(
      path.join(tempDir, 'output/draft/cold-mary.md'),
      'utf-8',
    );
    expect(written).toMatch(/status: sent/);
    // Old draft status should be gone.
    expect(written).not.toMatch(/^status: draft$/m);
    // Body unchanged.
    expect(written).toContain('Hi Mary,');
  });

  it('updates a record status using entity_type/entity_id', async () => {
    await executeWriteOutput(tempDir, {
      type: 'record',
      slug: 'q1-read',
      body: 'Account read.',
      fields: {
        entity_type: 'account',
        entity_id: 'acme',
        observed_at: '2026-04-28',
      },
    });
    const r = await executeUpdateOutputStatus(tempDir, {
      type: 'record',
      slug: 'q1-read',
      status: 'archived',
      entity_type: 'account',
      entity_id: 'acme',
    });
    expect(r.ok).toBe(true);
  });
});
