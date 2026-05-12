import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  acceptEscalation,
  acceptProposedVerb,
  commentOnEscalation,
  declineEscalation,
  declineProposedVerb,
  editProposedVerb,
  listEscalations,
  listOpenEscalations,
  listProposedVerbs,
  loadEscalation,
  loadProposedVerb,
  TriageNotFoundError,
  TriageValidationError,
} from './triage.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-triage-'));
  await fs.mkdir(path.join(tempDir, 'escalations'), { recursive: true });
  await fs.mkdir(path.join(tempDir, 'verbs', 'proposed'), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeEscalation(id: string, body: string): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'escalations', `${id}.md`), body, 'utf-8');
}

async function writeProposedVerb(slug: string, body: string): Promise<void> {
  await fs.writeFile(path.join(tempDir, 'verbs', 'proposed', `${slug}.md`), body, 'utf-8');
}

describe('listEscalations / listOpenEscalations', () => {
  it('returns empty when escalations dir is missing', async () => {
    await fs.rm(path.join(tempDir, 'escalations'), { recursive: true });
    expect(await listEscalations(tempDir)).toEqual([]);
    expect(await listOpenEscalations(tempDir)).toEqual([]);
  });

  it('skips README.md, returns summaries, filters by status', async () => {
    await fs.writeFile(path.join(tempDir, 'escalations', 'README.md'), '# README', 'utf-8');
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: open\n---\n\n# Need help with widget\n\nbody`,
    );
    await writeEscalation(
      '2026-05-02-b',
      `---\nkind: improvement\nurgency: low\ncreated: 2026-05-02\nstatus: accepted\n---\n\n# nice idea\n\nbody`,
    );
    const all = await listEscalations(tempDir);
    expect(all).toHaveLength(2);
    const open = await listEscalations(tempDir, 'open');
    expect(open.map((e) => e.id)).toEqual(['2026-05-01-a']);
    const accepted = await listEscalations(tempDir, 'accepted');
    expect(accepted.map((e) => e.id)).toEqual(['2026-05-02-b']);
  });

  it('sorts open before resolved, then by urgency', async () => {
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: resolved\n---\n# A`,
    );
    await writeEscalation(
      '2026-05-02-b',
      `---\nkind: help\nurgency: high\ncreated: 2026-05-02\nstatus: open\n---\n# B`,
    );
    const all = await listEscalations(tempDir);
    expect(all.map((e) => e.title)).toEqual(['B', 'A']);
  });
});

describe('loadEscalation', () => {
  it('returns the full detail including body', async () => {
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: help\nurgency: high\ncreated: 2026-05-01\nstatus: open\nagent_context: chat\n---\n\n# Need help\n\nasking for X`,
    );
    const detail = await loadEscalation(tempDir, '2026-05-01-a');
    expect(detail.title).toBe('Need help');
    expect(detail.body).toContain('asking for X');
    expect(detail.urgency).toBe('high');
    expect(detail.agent_context).toBe('chat');
  });

  it('throws TriageNotFoundError when the file is missing', async () => {
    await expect(loadEscalation(tempDir, '2026-05-01-missing')).rejects.toBeInstanceOf(
      TriageNotFoundError,
    );
  });

  it('refuses path-traversal ids', async () => {
    await expect(loadEscalation(tempDir, '../foo')).rejects.toBeInstanceOf(TriageValidationError);
    await expect(loadEscalation(tempDir, 'foo/bar')).rejects.toBeInstanceOf(TriageValidationError);
    await expect(loadEscalation(tempDir, '')).rejects.toBeInstanceOf(TriageValidationError);
  });
});

describe('acceptEscalation', () => {
  it('flips status to accepted and appends an operator note', async () => {
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: improvement\nurgency: low\ncreated: 2026-05-01\nstatus: open\n---\n\n# A\n\noriginal body`,
    );
    const result = await acceptEscalation(tempDir, '2026-05-01-a', 'will do this week');
    expect(result.status).toBe('accepted');

    const text = await fs.readFile(path.join(tempDir, 'escalations', '2026-05-01-a.md'), 'utf-8');
    expect(text).toMatch(/^---\n/);
    expect(text).toContain('status: accepted');
    expect(text).toContain('original body');
    expect(text).toContain('## Operator note');
    expect(text).toContain('will do this week');
  });

  it('uses a generic accepted note when no operator note is given', async () => {
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: open\n---\n# A\n\nbody`,
    );
    await acceptEscalation(tempDir, '2026-05-01-a');
    const text = await fs.readFile(path.join(tempDir, 'escalations', '2026-05-01-a.md'), 'utf-8');
    expect(text).toContain('Accepted.');
  });

  it('refuses unknown ids', async () => {
    await expect(acceptEscalation(tempDir, '2026-05-01-missing')).rejects.toBeInstanceOf(
      TriageNotFoundError,
    );
  });
});

describe('declineEscalation', () => {
  it('marks declined, records reason, appends note', async () => {
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: improvement\nurgency: low\ncreated: 2026-05-01\nstatus: open\n---\n# A\n\nbody`,
    );
    await declineEscalation(tempDir, '2026-05-01-a', 'duplicate of #42');
    const text = await fs.readFile(path.join(tempDir, 'escalations', '2026-05-01-a.md'), 'utf-8');
    expect(text).toContain('status: declined');
    expect(text).toContain("decline_reason: 'duplicate of #42'");
    expect(text).toContain('duplicate of #42');
  });

  it('requires a non-empty reason', async () => {
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: improvement\nurgency: low\ncreated: 2026-05-01\nstatus: open\n---\n# A`,
    );
    await expect(declineEscalation(tempDir, '2026-05-01-a', '  ')).rejects.toBeInstanceOf(
      TriageValidationError,
    );
  });
});

describe('commentOnEscalation', () => {
  it('appends a note without changing status', async () => {
    await writeEscalation(
      '2026-05-01-a',
      `---\nkind: help\nurgency: normal\ncreated: 2026-05-01\nstatus: open\n---\n# A\n\nbody`,
    );
    const before = await loadEscalation(tempDir, '2026-05-01-a');
    expect(before.status).toBe('open');
    await commentOnEscalation(tempDir, '2026-05-01-a', 'looking at this');
    const after = await loadEscalation(tempDir, '2026-05-01-a');
    expect(after.status).toBe('open');
    expect(after.body).toContain('looking at this');
  });
});

describe('listProposedVerbs', () => {
  it('returns empty when verbs/proposed/ is missing', async () => {
    await fs.rm(path.join(tempDir, 'verbs', 'proposed'), { recursive: true });
    expect(await listProposedVerbs(tempDir)).toEqual([]);
  });

  it('lists proposed verbs and skips README + declined drafts', async () => {
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'proposed', 'README.md'),
      '# README',
      'utf-8',
    );
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\nbody`,
    );
    await writeProposedVerb(
      'rejected',
      `---\ndescription: never mind\nproposed_by: chat\ncreated: 2026-05-01\nstatus: declined\ndecline_reason: 'out of scope'\n---\n\nbody`,
    );
    const list = await listProposedVerbs(tempDir);
    expect(list.map((v) => v.slug)).toEqual(['tidy-up']);
    expect(list[0]?.description).toBe('keep things clean');
  });
});

describe('loadProposedVerb', () => {
  it('returns full detail', async () => {
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\nbody content here`,
    );
    const d = await loadProposedVerb(tempDir, 'tidy-up');
    expect(d.body).toContain('body content here');
    expect(d.description).toBe('keep things clean');
  });

  it('refuses invalid slugs', async () => {
    await expect(loadProposedVerb(tempDir, 'Bad Slug')).rejects.toBeInstanceOf(
      TriageValidationError,
    );
    await expect(loadProposedVerb(tempDir, '../escape')).rejects.toBeInstanceOf(
      TriageValidationError,
    );
  });
});

describe('editProposedVerb', () => {
  it('replaces the body, preserves frontmatter', async () => {
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\noriginal body`,
    );
    await editProposedVerb(tempDir, 'tidy-up', 'refined operator body');
    const d = await loadProposedVerb(tempDir, 'tidy-up');
    expect(d.body).toContain('refined operator body');
    expect(d.body).not.toContain('original body');
    expect(d.description).toBe('keep things clean');
    expect(d.status).toBe('proposed');
  });
});

describe('acceptProposedVerb', () => {
  it('moves verbs/proposed/<slug>.md to verbs/<slug>.md with status accepted', async () => {
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\nbody`,
    );
    const result = await acceptProposedVerb(tempDir, 'tidy-up');
    expect(result.movedTo).toBe(path.join('verbs', 'tidy-up.md'));

    const liveText = await fs.readFile(path.join(tempDir, 'verbs', 'tidy-up.md'), 'utf-8');
    expect(liveText).toContain('status: accepted');
    expect(liveText).toContain('accepted_at:');
    expect(liveText).toContain('body');

    await expect(
      fs.access(path.join(tempDir, 'verbs', 'proposed', 'tidy-up.md')),
    ).rejects.toThrow();
  });

  it('applies bodyOverride when supplied', async () => {
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\nraw draft body`,
    );
    await acceptProposedVerb(tempDir, 'tidy-up', { bodyOverride: 'operator-refined body' });
    const liveText = await fs.readFile(path.join(tempDir, 'verbs', 'tidy-up.md'), 'utf-8');
    expect(liveText).toContain('operator-refined body');
    expect(liveText).not.toContain('raw draft body');
  });

  it('refuses when a live verb with the same slug already exists', async () => {
    await fs.writeFile(path.join(tempDir, 'verbs', 'tidy-up.md'), 'existing live verb', 'utf-8');
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\nbody`,
    );
    await expect(acceptProposedVerb(tempDir, 'tidy-up')).rejects.toBeInstanceOf(
      TriageValidationError,
    );
    // Live verb is preserved untouched.
    const live = await fs.readFile(path.join(tempDir, 'verbs', 'tidy-up.md'), 'utf-8');
    expect(live).toBe('existing live verb');
  });

  it('appends a row to CLAUDE.md when the verbs table is present', async () => {
    await fs.writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      [
        '# A role',
        '',
        '## My verbs',
        '',
        '| Verb | File | Input Stage | Output Stage |',
        '|------|------|-------------|-------------|',
        '| **Persona** | `persona.md` | _(loaded)_ | identity |',
        '',
        'more text',
      ].join('\n'),
      'utf-8',
    );
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\nbody`,
    );
    const result = await acceptProposedVerb(tempDir, 'tidy-up');
    expect(result.claudeMdUpdated).toBe(true);
    const claude = await fs.readFile(path.join(tempDir, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('| **Tidy Up** | `verbs/tidy-up.md` | <unset> | keep things clean |');
  });

  it('does not duplicate the CLAUDE.md row if it already appears', async () => {
    await fs.writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      [
        '| Verb | File | Input Stage | Output Stage |',
        '|------|------|-------------|-------------|',
        '| **Tidy** | `verbs/tidy-up.md` | _(x)_ | y |',
        '',
      ].join('\n'),
      'utf-8',
    );
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nstatus: proposed\n---\n\nbody`,
    );
    const result = await acceptProposedVerb(tempDir, 'tidy-up');
    expect(result.claudeMdUpdated).toBe(false);
  });
});

describe('declineProposedVerb', () => {
  it('marks declined, records reason, keeps the file in place', async () => {
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: keep things clean\nproposed_by: chat\ncreated: 2026-05-01\nstatus: proposed\n---\n\nbody`,
    );
    await declineProposedVerb(tempDir, 'tidy-up', 'duplicate of existing verb');
    const d = await loadProposedVerb(tempDir, 'tidy-up');
    expect(d.status).toBe('declined');
    expect(d.frontmatter['decline_reason']).toBe('duplicate of existing verb');

    // Declined drafts no longer surface on the list.
    const list = await listProposedVerbs(tempDir);
    expect(list).toHaveLength(0);
  });

  it('requires a non-empty reason', async () => {
    await writeProposedVerb(
      'tidy-up',
      `---\ndescription: x\nstatus: proposed\n---\n\nbody`,
    );
    await expect(declineProposedVerb(tempDir, 'tidy-up', '  ')).rejects.toBeInstanceOf(
      TriageValidationError,
    );
  });
});
