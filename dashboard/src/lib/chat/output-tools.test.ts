import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseFrontmatter } from '../frontmatter.js';
import { RESERVED_OUTPUT_KEYS } from '../output/types.js';
import {
  executeUpdateOutputStatus,
  executeWriteOutput,
} from './output-tools.js';
import { WRITE_OUTPUT_TOOL } from './tool-schemas.js';

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

describe('executeWriteOutput extra_fields', () => {
  const NOW = new Date('2026-09-29T03:00:00Z');

  function frontmatterKeys(text: string): string[] {
    const block = text.split('\n---')[0] ?? '';
    return block
      .split('\n')
      .slice(1)
      .map((line) => line.slice(0, line.indexOf(':')));
  }

  function draftWith(extra: unknown, slug = 'reply-reporter'): Record<string, unknown> {
    return {
      type: 'draft',
      slug,
      body: 'Thanks for the report.',
      fields: { recipient: 'reporter@example.com', channel: 'email', subject: 'Re: report' },
      extra_fields: extra,
    };
  }

  async function readDraft(slug = 'reply-reporter'): Promise<string> {
    return fs.readFile(path.join(tempDir, `output/draft/${slug}.md`), 'utf-8');
  }

  it('writes extra fields after the known fields and before the timestamps', async () => {
    const r = await executeWriteOutput(
      tempDir,
      draftWith({ gmail_thread_id: '18f2a9c0b1d2e3f4', reporter_ref: 'VDP-2026-014' }),
      NOW,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data['extra_fields']).toEqual(['gmail_thread_id', 'reporter_ref']);

    const written = await readDraft();
    expect(frontmatterKeys(written)).toEqual([
      'type',
      'slug',
      'status',
      'recipient',
      'channel',
      'subject',
      'gmail_thread_id',
      'reporter_ref',
      'created',
      'updated',
    ]);
    expect(written).toMatch(/^gmail_thread_id: 18f2a9c0b1d2e3f4$/m);
    expect(written).toMatch(/^reporter_ref: VDP-2026-014$/m);
  });

  it('round-trips values that need quoting through the frontmatter parser', async () => {
    const value = 'thread:abc #1 "quoted"';
    const r = await executeWriteOutput(tempDir, draftWith({ external_ref: value }), NOW);
    expect(r.ok).toBe(true);
    const { frontmatter } = parseFrontmatter(await readDraft());
    expect(frontmatter['external_ref']).toBe(value);
  });

  it('produces byte-identical output when extra_fields is absent or empty', async () => {
    const base = draftWith(undefined, 'no-extras');
    delete base['extra_fields'];
    const a = await executeWriteOutput(tempDir, base, NOW);
    const b = await executeWriteOutput(tempDir, draftWith({}, 'empty-extras'), NOW);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok) return;
    expect(a.data['extra_fields']).toBeUndefined();

    const withoutExtras = await readDraft('no-extras');
    const withEmpty = await readDraft('empty-extras');
    expect(withEmpty.replace(/empty-extras/g, 'no-extras')).toBe(withoutExtras);
    expect(frontmatterKeys(withoutExtras)).toEqual([
      'type',
      'slug',
      'status',
      'recipient',
      'channel',
      'subject',
      'created',
      'updated',
    ]);
  });

  it.each([
    ['uppercase', 'Thread_id'],
    ['leading digit', '1thread'],
    ['leading underscore', '_thread'],
    ['hyphen', 'thread-id'],
    ['colon', 'thread:id'],
    ['too long', `a${'b'.repeat(40)}`],
  ])('refuses a malformed key (%s)', async (_label, key) => {
    const r = await executeWriteOutput(tempDir, draftWith({ [key]: 'x' }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/extra_fields/);
    await expect(readDraft()).rejects.toThrow();
  });

  it('accepts a key at the 40-character limit', async () => {
    const r = await executeWriteOutput(tempDir, draftWith({ [`a${'b'.repeat(39)}`]: 'x' }), NOW);
    expect(r.ok).toBe(true);
  });

  it.each([
    'type',
    'slug',
    'status',
    'created',
    'updated',
    'recipient',
    'channel',
    'subject',
    // Known fields of other types are reserved too.
    'title',
    'audience',
    'entity_type',
    'entity_id',
    'observed_at',
    'goal',
    'owner',
    'topic',
    'tags',
  ])('refuses the reserved key %s', async (key) => {
    const r = await executeWriteOutput(tempDir, draftWith({ [key]: 'x' }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(new RegExp(`'${key}'.*reserved`));
    await expect(readDraft()).rejects.toThrow();
  });

  it('refuses more than 10 extra fields', async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 11; i++) extra[`field_${i}`] = 'x';
    const r = await executeWriteOutput(tempDir, draftWith(extra), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/at most 10/);
  });

  it('accepts exactly 10 extra fields', async () => {
    const extra: Record<string, string> = {};
    for (let i = 0; i < 10; i++) extra[`field_${i}`] = 'x';
    const r = await executeWriteOutput(tempDir, draftWith(extra), NOW);
    expect(r.ok).toBe(true);
  });

  it.each([
    ['newline', 'a\nstatus: sent'],
    ['carriage return', 'a\rb'],
    ['tab', 'a\tb'],
    ['empty', ''],
    ['over 500 chars', 'x'.repeat(501)],
    ['leading whitespace', ' abc'],
    ['trailing whitespace', 'abc '],
    ['quote that would be escaped', "it's: broken"],
  ])('refuses a value with %s', async (_label, value) => {
    const r = await executeWriteOutput(tempDir, draftWith({ external_ref: value }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/extra_fields\.external_ref/);
    await expect(readDraft()).rejects.toThrow();
  });

  it('accepts a value at the 500-character limit', async () => {
    const r = await executeWriteOutput(tempDir, draftWith({ external_ref: 'x'.repeat(500) }), NOW);
    expect(r.ok).toBe(true);
  });

  it('refuses non-string values', async () => {
    const r = await executeWriteOutput(tempDir, draftWith({ external_ref: 42 }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/extra_fields/);
  });

  it('keeps extra fields through update_output_status', async () => {
    await executeWriteOutput(tempDir, draftWith({ gmail_thread_id: 'thread:18f2a9c0' }), NOW);
    const before = await readDraft();

    const r = await executeUpdateOutputStatus(
      tempDir,
      { type: 'draft', slug: 'reply-reporter', status: 'ready' },
      new Date('2026-09-30T03:00:00Z'),
    );
    expect(r.ok).toBe(true);

    const after = await readDraft();
    expect(after).toMatch(/^status: ready$/m);
    const extraLine = before.split('\n').find((l) => l.startsWith('gmail_thread_id:'));
    expect(extraLine).toBe("gmail_thread_id: 'thread:18f2a9c0'");
    expect(after.split('\n')).toContain(extraLine);
    expect(frontmatterKeys(after)).toEqual(frontmatterKeys(before));
  });
});

describe('WRITE_OUTPUT_TOOL schema', () => {
  it('documents extra_fields with every reserved key', () => {
    const props = WRITE_OUTPUT_TOOL.input_schema.properties as Record<
      string,
      { description?: string }
    >;
    const description = props['extra_fields']?.description ?? '';
    for (const key of RESERVED_OUTPUT_KEYS) expect(description).toContain(key);
    expect(WRITE_OUTPUT_TOOL.input_schema.required).not.toContain('extra_fields');
  });
});
