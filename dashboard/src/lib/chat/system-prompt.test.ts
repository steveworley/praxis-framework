import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildSystemPrompt,
  parseToolsYaml,
  renderBusinessContextSection,
  stripMarkdownSection,
} from './system-prompt.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-sysprompt-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function seedPersona(): Promise<void> {
  const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n- **Working title**: CSM agent\n- **Role**: CSM agent\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I run weekly account reads\n\n## Hard inhibitions\n\n- I never send without approval\n`;
  await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
}

describe('buildSystemPrompt', () => {
  it('throws when persona.md is missing', async () => {
    await expect(buildSystemPrompt(tempDir)).rejects.toThrow(/persona\.md not found/);
  });

  it('opens with "You are <name> (<title>)." derived from persona identity', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt.startsWith('You are Iris Chen (CSM agent).')).toBe(true);
  });

  it('drops the parenthetical when working_title is not set', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I run weekly account reads\n\n## Hard inhibitions\n\n- I never send without approval\n`;
    await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt.startsWith('You are Iris Chen.\n')).toBe(true);
  });

  it('strips the persona H1 from the embedded body', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    // The "# Persona — Iris" header should not appear in the embedded body —
    // we replace it with the "You are Iris Chen." opener.
    expect(prompt).not.toContain('# Persona — Iris');
    // But the rest of the persona content should be there.
    expect(prompt).toContain('## Voice & Personality');
    expect(prompt).toContain('## Hard inhibitions');
  });

  it('includes Accountabilities and Success criteria sections when present', async () => {
    const text = `# Persona — Iris\n\n## Identity\n\n- **Full name**: Iris Chen\n\n## Voice & Personality\n\n- **direct** -- single-sentence opens\n\n## Capabilities\n\n- I run weekly account reads\n\n## Accountabilities\n\n- I'm responsible for draft quality before review.\n\n## Success criteria\n\n- Drafts land within ≤2 review cycles.\n\n## Hard inhibitions\n\n- I never send without approval\n`;
    await fs.writeFile(path.join(tempDir, 'persona.md'), text, 'utf-8');
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('## Accountabilities');
    expect(prompt).toContain("I'm responsible for draft quality before review.");
    expect(prompt).toContain('## Success criteria');
    expect(prompt).toContain('Drafts land within ≤2 review cycles.');
    // Ordering: identity → voice → capabilities → accountabilities → success criteria → inhibitions.
    const accIdx = prompt.indexOf('## Accountabilities');
    const succIdx = prompt.indexOf('## Success criteria');
    const capIdx = prompt.indexOf('## Capabilities');
    const inhIdx = prompt.indexOf('## Hard inhibitions');
    expect(capIdx).toBeLessThan(accIdx);
    expect(accIdx).toBeLessThan(succIdx);
    expect(succIdx).toBeLessThan(inhIdx);
  });

  it('omits Accountabilities and Success criteria when persona has none', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).not.toContain('## Accountabilities');
    expect(prompt).not.toContain('## Success criteria');
  });

  it('omits the verbs section when verbs/ is missing or empty', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).not.toContain('## Available verbs');
  });

  it('lists verbs by slug with a one-line summary', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'verbs'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'escalate.md'),
      '# Escalate\n\nFile a structured escalation when stuck or proposing change.\n',
      'utf-8',
    );
    await fs.writeFile(
      path.join(tempDir, 'verbs', 'account-read.md'),
      '---\nsummary: weekly read of the customer portfolio\n---\n\n# Account Read\n\nbody\n',
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('## Available verbs');
    expect(prompt).toContain('- account-read: weekly read of the customer portfolio');
    expect(prompt).toContain(
      '- escalate: File a structured escalation when stuck or proposing change.',
    );
  });

  it('includes the Hard rules section from CLAUDE.md when present', async () => {
    await seedPersona();
    await fs.writeFile(
      path.join(tempDir, 'CLAUDE.md'),
      '# I am Iris\n\nsome preamble\n\n## Hard rules I never break\n\n- I never send without approval\n- I always log decisions\n\n## Logging\n\nuse praxis log\n',
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('## Hard rules');
    expect(prompt).toContain('- I never send without approval');
    expect(prompt).toContain('- I always log decisions');
    // Should NOT pull in the next section (Logging).
    expect(prompt).not.toContain('use praxis log');
  });

  it('omits Hard rules when CLAUDE.md is missing', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).not.toContain('## Hard rules');
  });

  it('always emits the constitutional gated list under Autonomy', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('## Autonomy');
    expect(prompt).toContain('persona.md');
    expect(prompt).toContain('verbs/*.md');
    expect(prompt).toContain('CLAUDE.md');
  });

  it('lists open autonomy surfaces when lib/autonomy.yaml exists', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      'surfaces:\n  - path: memory/\n    mode: full\n  - path: verbs/proposed/\n    mode: full\n  - path: lib/customers.yaml\n    mode: gated\n',
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('- memory/ (mode: full)');
    expect(prompt).toContain('- verbs/proposed/ (mode: full)');
    // Gated entries should not appear in the allow list.
    expect(prompt).not.toContain('lib/customers.yaml (mode:');
  });

  it('includes tools when lib/tools.yaml is present', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'tools.yaml'),
      'capabilities:\n  bash:\n    description: "Shell execution scoped to the role workdir"\n  websearch:\n    description: "Web search via configured provider"\n',
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('## Available tools');
    expect(prompt).toContain('- bash: Shell execution scoped to the role workdir');
    expect(prompt).toContain('- websearch: Web search via configured provider');
  });

  it('omits the tools section when lib/tools.yaml is missing', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).not.toContain('## Available tools');
  });

  it('ends with the operator-greeting block and lists the growth tools', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('You are speaking with the operator');
    expect(prompt).toContain('`write_memory`');
    expect(prompt).toContain('`create_escalation`');
    expect(prompt).toContain('`propose_verb`');
    expect(prompt).toContain('`append_entry`');
    expect(prompt).toContain('`log_decision`');
  });

  it('lists operator-opened append-only surfaces with their config', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      [
        'surfaces:',
        '  - path: lib/research-strategies.yaml',
        '    mode: append-only',
        '    max_pending: 5',
        '    root_key: strategies',
        '    unique_by: id',
        '    why: |',
        '      Page conventions I notice during research.',
      ].join('\n'),
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('Operator-opened append-only surfaces');
    expect(prompt).toContain('`lib/research-strategies.yaml`');
    expect(prompt).toContain('root_key: strategies');
    expect(prompt).toContain('unique_by: id');
    expect(prompt).toContain('max_pending: 5');
    expect(prompt).toContain('Page conventions I notice during research.');
  });

  it('omits the append-only surfaces block when none are declared', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      'surfaces:\n  - path: memory/\n    mode: full\n',
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).not.toContain('Operator-opened append-only surfaces');
  });

  it('lists operator-opened inline-enrichment surfaces with their config', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      [
        'surfaces:',
        '  - path: lib/team.yaml',
        '    mode: inline-enrichment',
        '    root_key: members',
        '    unique_by: id',
        '    soft_fields:',
        '      - notes',
        '      - last_observed_at',
        '    why: |',
        '      Structured team data is operator-owned; I keep notes current.',
      ].join('\n'),
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('Operator-opened inline-enrichment surfaces');
    expect(prompt).toContain('`lib/team.yaml`');
    expect(prompt).toContain('root_key: members');
    expect(prompt).toContain('unique_by: id');
    expect(prompt).toContain('soft_fields: notes, last_observed_at');
    expect(prompt).toContain('Structured team data is operator-owned');
  });

  it('lists enrich_entry in the operator-greeting tool block', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('`enrich_entry`');
    expect(prompt).toContain('fifteen tools available');
  });

  it('lists run_verb and complete_verb in the operator-greeting tool block', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('`run_verb`');
    expect(prompt).toContain('`complete_verb`');
  });

  it('tells the model it can read role-home reference files with read_role_file', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('`read_role_file`');
    expect(prompt).toContain('### Reading your reference files');
    expect(prompt).toContain('Call `read_role_file(path)`');
    expect(prompt).toContain('rather than from memory');
  });

  it('tells the model to discover file paths with list_role_files instead of guessing', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('- `list_role_files`');
    expect(prompt).toContain('call `list_role_files(path)` on the directory first');
  });

  it('includes the Running a verb guidance section', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('### Running a verb');
    expect(prompt).toContain("call `run_verb(slug)`");
    expect(prompt).toContain('`verb_started` activity event');
  });

  it('lists archive_memory in the operator-greeting tool block', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('`archive_memory`');
  });

  it('lists consolidate_memory in the operator-greeting tool block', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('`consolidate_memory`');
  });

  it('lists adjust_param in the operator-greeting tool block', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('`adjust_param`');
  });

  it('lists operator-opened bounded surfaces with their bounds', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      [
        'surfaces:',
        '  - path: lib/warmup.yaml',
        '    mode: bounded',
        '    bounds:',
        '      sends_per_day: { min: 10, max: 100, step: 5 }',
        '      weeks_to_full_send_rate: { min: 4, max: 12 }',
        '      new_thread_ratio: { min: 0.1, max: 0.9 }',
        '    why: |',
        '      Warmup throttle parameters; I tune within ranges.',
      ].join('\n'),
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).toContain('Operator-opened bounded parameters');
    expect(prompt).toContain('`lib/warmup.yaml`');
    expect(prompt).toContain('sends_per_day [10–100 step 5]');
    expect(prompt).toContain('weeks_to_full_send_rate [4–12]');
    expect(prompt).toContain('new_thread_ratio [0.1–0.9]');
    expect(prompt).toContain('Warmup throttle parameters');
  });

  it('omits the bounded surfaces block when none are declared', async () => {
    await seedPersona();
    await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'lib', 'autonomy.yaml'),
      'surfaces:\n  - path: memory/\n    mode: full\n',
      'utf-8',
    );
    const prompt = await buildSystemPrompt(tempDir);
    expect(prompt).not.toContain('Operator-opened bounded parameters');
  });
});

describe('buildSystemPrompt — recently decided escalations', () => {
  const NOW = new Date('2026-11-06T12:00:00+10:00');
  const HEADING = '## Recently decided escalations';

  async function seedEscalation(
    id: string,
    opts: { status: string; kind?: string; title?: string; notes?: string[]; declineReason?: string; mtime?: Date },
  ): Promise<void> {
    const dir = path.join(tempDir, 'escalations');
    await fs.mkdir(dir, { recursive: true });
    const fm = ['---', `kind: ${opts.kind ?? 'help'}`, 'urgency: normal', 'created: 2026-10-01', `status: ${opts.status}`];
    if (opts.declineReason) fm.push(`decline_reason: ${opts.declineReason}`);
    fm.push('---');
    const body = ['', `# ${opts.title ?? id}`, '', 'Agent body.', '', ...(opts.notes ?? [])];
    const file = path.join(dir, `${id}.md`);
    await fs.writeFile(file, [...fm, ...body, ''].join('\n'), 'utf-8');
    if (opts.mtime) await fs.utimes(file, opts.mtime, opts.mtime);
  }

  function note(ts: string, kind: string, text: string): string {
    return `## Operator note · ${ts} · ${kind}\n\n${text}\n`;
  }

  it('lists an accepted escalation with id, path, kind, status, title and the operator note', async () => {
    await seedPersona();
    const id = '2026-11-05-6e1b-bounty-solicitation-from-sebastian-romeo-your-call-before-i-';
    await seedEscalation(id, {
      status: 'accepted',
      title: 'Bounty solicitation from Sebastian Romeo',
      notes: [
        note(
          '2026-11-05T14:00:00+10:00',
          'accepted',
          "Send an acknowledgement but as per VDP we don't have a bug bounty program and don't pay for reports.",
        ),
      ],
    });
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    expect(prompt).toContain(HEADING);
    expect(prompt).toContain(`\`${id}\``);
    expect(prompt).toContain(`\`escalations/${id}.md\``);
    expect(prompt).toContain('kind: help');
    expect(prompt).toContain('status: accepted');
    expect(prompt).toContain('Bounty solicitation from Sebastian Romeo');
    expect(prompt).toContain("we don't have a bug bounty program and don't pay for reports.");
    expect(prompt).toContain('read_role_file');
  });

  it('excludes open escalations', async () => {
    await seedPersona();
    await seedEscalation('2026-11-05-open-one', { status: 'open' });
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    expect(prompt).not.toContain(HEADING);
    expect(prompt).not.toContain('2026-11-05-open-one');
  });

  it('excludes escalations decided outside the 14-day window', async () => {
    await seedPersona();
    await seedEscalation('2026-10-01-old', {
      status: 'accepted',
      notes: [note('2026-10-20T09:00:00+10:00', 'accepted', 'Old news.')],
    });
    await seedEscalation('2026-10-25-recent', {
      status: 'accepted',
      notes: [note('2026-10-25T09:00:00+10:00', 'accepted', 'Fresh.')],
    });
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    expect(prompt).toContain('2026-10-25-recent');
    expect(prompt).not.toContain('2026-10-01-old');
  });

  it('shows the decline reason for a declined escalation', async () => {
    await seedPersona();
    await seedEscalation('2026-11-01-declined', {
      status: 'declined',
      declineReason: 'Out of scope for this quarter.',
      notes: [note('2026-11-02T09:00:00+10:00', 'declined', 'Out of scope for this quarter.')],
    });
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    expect(prompt).toContain('status: declined');
    expect(prompt).toContain('Out of scope for this quarter.');
  });

  it('falls back to decline_reason and file mtime when there is no operator note', async () => {
    await seedPersona();
    await seedEscalation('2026-11-01-hand-edited', {
      status: 'declined',
      declineReason: 'Duplicate of last week.',
      mtime: new Date('2026-11-03T09:00:00+10:00'),
    });
    await seedEscalation('2026-09-01-stale', {
      status: 'resolved',
      mtime: new Date('2026-09-02T09:00:00+10:00'),
    });
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    expect(prompt).toContain('2026-11-01-hand-edited');
    expect(prompt).toContain('Duplicate of last week.');
    expect(prompt).not.toContain('2026-09-01-stale');
  });

  it('truncates long notes', async () => {
    await seedPersona();
    const long = 'x'.repeat(800);
    await seedEscalation('2026-11-04-long', {
      status: 'accepted',
      notes: [note('2026-11-04T09:00:00+10:00', 'accepted', long)],
    });
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    expect(prompt).not.toContain(long);
    expect(prompt).toContain(`${'x'.repeat(500)}…`);
  });

  it('orders most recent first and caps at 10 entries', async () => {
    await seedPersona();
    // Decision time runs opposite to filename order: esc-01 is the most recent.
    for (let day = 1; day <= 12; day += 1) {
      const dd = String(day).padStart(2, '0');
      const hh = String(13 - day).padStart(2, '0');
      await seedEscalation(`2026-10-${dd}-esc-${dd}`, {
        status: 'accepted',
        notes: [note(`2026-11-05T${hh}:00:00+10:00`, 'accepted', `note ${dd}`)],
      });
    }
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    const section = prompt.slice(prompt.indexOf(HEADING));
    const ids = [...section.matchAll(/^- `(2026-10-\d\d-esc-\d\d)`/gm)].map((m) => m[1]);
    expect(ids).toEqual(
      Array.from({ length: 10 }, (_, i) => {
        const dd = String(i + 1).padStart(2, '0');
        return `2026-10-${dd}-esc-${dd}`;
      }),
    );
  });

  it('omits the section entirely when there are no escalations', async () => {
    await seedPersona();
    const prompt = await buildSystemPrompt(tempDir, { now: NOW });
    expect(prompt).not.toContain(HEADING);
  });
});

describe('parseToolsYaml', () => {
  it('parses capability names and descriptions', () => {
    const text =
      'capabilities:\n  bash:\n    description: "shell"\n    transport_options: [native]\n  edit:\n    description: read/write\n';
    const tools = parseToolsYaml(text);
    expect(tools).toEqual([
      { name: 'bash', description: 'shell' },
      { name: 'edit', description: 'read/write' },
    ]);
  });

  it('returns an empty list when capabilities key is absent', () => {
    expect(parseToolsYaml('# nothing here\n')).toEqual([]);
  });

  it('skips capabilities that have no description', () => {
    const text = 'capabilities:\n  bare:\n    transport_options: [native]\n  named:\n    description: ok\n';
    expect(parseToolsYaml(text)).toEqual([{ name: 'named', description: 'ok' }]);
  });
});

describe('stripMarkdownSection', () => {
  it('removes a named section and its body up to the next ## or EOF', () => {
    const md = '## Organisation\n\n- **Name**: Acme\n\nprose\n\n## Identity\n\n- **Role**: x';
    const out = stripMarkdownSection(md, 'Organisation');
    expect(out).not.toContain('## Organisation');
    expect(out).toContain('## Identity');
  });
  it('is a no-op when the section is absent', () => {
    const md = '## Identity\n\n- **Role**: x';
    expect(stripMarkdownSection(md, 'Organisation')).toBe(md);
  });
});

describe('renderBusinessContextSection', () => {
  it('renders scalars as bullets and prose as subsections, skipping empties', () => {
    const bc = {
      version: 1,
      business_context: [
        { key: 'name', label: 'Name', value: 'Northwind' },
        { key: 'website', label: 'Website', value: '' },
        { key: 'what_we_do', label: 'What we do', value: 'We roast coffee.' },
      ],
    };
    const out = renderBusinessContextSection(bc);
    expect(out).toContain('## Business context');
    expect(out).toContain('- **Name**: Northwind');
    expect(out).not.toContain('Website');
    expect(out).toContain('### What we do');
    expect(out).toContain('We roast coffee.');
  });
  it('returns null when there are no non-empty fields', () => {
    expect(renderBusinessContextSection({ version: 1, business_context: [] })).toBeNull();
  });
});
