import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSystemPrompt, parseToolsYaml } from './system-prompt.ts';

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
    expect(prompt).toContain('eleven tools available');
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
