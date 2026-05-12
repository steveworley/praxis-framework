import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseToolsYaml } from './catalog.js';
import { injectVerbsTable, seedRole } from './seed.js';
import { SeedError, type SeedInput } from './types.js';

/**
 * Tests run against the live framework template at <repo>/template/, which
 * the package's resolver will find by walking up from the package's location.
 * That keeps the tests honest — if anyone accidentally drops a required file
 * from the template, the seed will fail and the tests will catch it.
 */

const sampleInput = (): SeedInput => ({
  organisation: {
    name: 'Acme Co',
    website: 'https://acme.example',
    sector: 'B2B SaaS',
    size: 'small',
    description: 'We sell widgets to other widget-makers.',
  },
  role_definition: {
    role_name: 'Pat Example',
    one_sentence_purpose: 'I am the example role used in seed tests.',
  },
  identity: { email: 'pat@acme.example', location: 'Brisbane' },
  voice_traits: [
    { trait: 'direct', qualifiers: ['short sentences, no hedging'] },
    { trait: 'curious', qualifiers: [] },
  ],
  capabilities: ['I write tests', 'I refuse to ship without coverage'],
  inhibitions: ['I never edit prod data without an approval flow'],
  initial_verbs: [
    {
      slug: 'first-verb',
      description: ['Run the kickoff routine.', 'Surface anything that blocks.'],
    },
  ],
  tools: [],
});

describe('seedRole', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-seed-'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('seeds expected files into an empty target', async () => {
    const result = await seedRole(sampleInput(), tmp);

    expect(result.targetPath).toBe(path.resolve(tmp));
    expect(result.filesSkipped).toEqual([]);

    const expected = [
      'CLAUDE.md',
      'persona.md',
      'verbs/escalate.md',
      'verbs/proposed/README.md',
      'memory/README.md',
      'escalations/README.md',
      'lib/autonomy.yaml',
      '.gitignore',
      'verbs/first-verb.md',
    ];
    for (const rel of expected) {
      expect(result.filesWritten).toContain(rel);
      const stat = await fs.stat(path.join(tmp, rel));
      expect(stat.isFile()).toBe(true);
    }

    // bin/log is no longer seeded — operators invoke `praxis log` instead.
    expect(result.filesWritten).not.toContain('bin/log');
    await expect(fs.access(path.join(tmp, 'bin', 'log'))).rejects.toThrow();
  });

  it('substitutes ROLE_NAME and persona sections', async () => {
    const input = sampleInput();
    await seedRole(input, tmp);

    const persona = await fs.readFile(path.join(tmp, 'persona.md'), 'utf-8');
    expect(persona).toContain('Persona — Pat Example');
    expect(persona).toContain('- **Name**: Acme Co');
    expect(persona).toContain('- **Full name**: Pat Example');
    expect(persona).toContain('- **Email**: pat@acme.example');
    // Trait with one qualifier renders inline.
    expect(persona).toContain('- **direct** -- short sentences, no hedging');
    // Trait with no qualifiers falls back to the library description.
    expect(persona).toContain('- **curious** -- asks questions before pitching; pulls on threads');
    expect(persona).toContain('- I write tests');
    expect(persona).toContain('- I never edit prod data without an approval flow');
  });

  it('renders multi-qualifier voice traits as nested bullets', async () => {
    const input: SeedInput = {
      ...sampleInput(),
      voice_traits: [
        {
          trait: 'direct',
          qualifiers: [
            'short sentences, no hedging',
            'calls out tradeoffs upfront',
          ],
        },
      ],
    };
    await seedRole(input, tmp);
    const persona = await fs.readFile(path.join(tmp, 'persona.md'), 'utf-8');
    expect(persona).toMatch(/- \*\*direct\*\*\n {2}- short sentences, no hedging\n {2}- calls out tradeoffs upfront/);
  });

  it('writes a CLAUDE.md with the operator-supplied description', async () => {
    await seedRole(sampleInput(), tmp);
    const claude = await fs.readFile(path.join(tmp, 'CLAUDE.md'), 'utf-8');
    expect(claude).toContain('Pat Example');
    expect(claude).toContain('I am the example role used in seed tests.');
    expect(claude).not.toMatch(/\{ROLE_NAME\}/);
    expect(claude).not.toMatch(/\{One-line first-person description/);
  });

  it('renders a stub for each initial verb with bullet body content', async () => {
    const result = await seedRole(sampleInput(), tmp);
    expect(result.filesWritten).toContain('verbs/first-verb.md');
    const stub = await fs.readFile(path.join(tmp, 'verbs/first-verb.md'), 'utf-8');
    expect(stub).toContain('# First Verb');
    expect(stub).toContain('You are Pat Example.');
    expect(stub).toContain('## What this verb does');
    expect(stub).toContain('- Run the kickoff routine.');
    expect(stub).toContain('- Surface anything that blocks.');
  });

  it('renders a TODO marker when the verb has no description bullets', async () => {
    const input: SeedInput = {
      ...sampleInput(),
      initial_verbs: [{ slug: 'bare-verb', description: [] }],
    };
    await seedRole(input, tmp);
    const stub = await fs.readFile(path.join(tmp, 'verbs/bare-verb.md'), 'utf-8');
    expect(stub).toContain('# Bare Verb');
    expect(stub).toContain('## What this verb does');
    expect(stub).toContain('TODO');
  });

  it('refuses to seed into a non-empty conflicting directory and writes nothing', async () => {
    // Plant a conflicting file before the seed runs.
    await fs.writeFile(path.join(tmp, 'persona.md'), 'pre-existing', 'utf-8');

    await expect(seedRole(sampleInput(), tmp)).rejects.toBeInstanceOf(SeedError);

    // The original conflicting file is untouched and no new files were written.
    const persona = await fs.readFile(path.join(tmp, 'persona.md'), 'utf-8');
    expect(persona).toBe('pre-existing');
    await expect(fs.access(path.join(tmp, 'CLAUDE.md'))).rejects.toThrow();
  });

  it('overwrites when overwrite: true is set', async () => {
    await fs.writeFile(path.join(tmp, 'persona.md'), 'pre-existing', 'utf-8');

    const result = await seedRole(sampleInput(), tmp, { overwrite: true });
    expect(result.filesWritten).toContain('persona.md');
    const persona = await fs.readFile(path.join(tmp, 'persona.md'), 'utf-8');
    expect(persona).toContain('Persona — Pat Example');
  });

  it('dry-run mode reports planned files without writing', async () => {
    const result = await seedRole(sampleInput(), tmp, { dryRun: true });
    expect(result.filesWritten.length).toBeGreaterThan(0);
    expect(result.filesSkipped).toEqual([]);

    // Nothing should exist on disk.
    const entries = await fs.readdir(tmp);
    expect(entries).toEqual([]);
  });

  it('rejects malformed input with INVALID_INPUT', async () => {
    const bad = { ...sampleInput(), voice_traits: [] };
    try {
      await seedRole(bad as unknown as SeedInput, tmp);
      throw new Error('expected throw');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SeedError);
      if (e instanceof SeedError) {
        expect(e.code).toBe('INVALID_INPUT');
      }
    }
  });

  it('throws TEMPLATE_MISSING when override path is bogus', async () => {
    try {
      await seedRole(sampleInput(), tmp, { templatePath: '/nonexistent/praxis-template' });
      throw new Error('expected throw');
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(SeedError);
      if (e instanceof SeedError) {
        expect(e.code).toBe('TEMPLATE_MISSING');
      }
    }
  });

  describe('lib/tools.yaml', () => {
    it('writes built-ins plus operator-selected optional tools', async () => {
      const input: SeedInput = {
        ...sampleInput(),
        tools: ['websearch', 'mcp:google-workspace'],
      };
      const result = await seedRole(input, tmp);
      expect(result.filesWritten).toContain('lib/tools.yaml');

      const body = await fs.readFile(path.join(tmp, 'lib/tools.yaml'), 'utf-8');
      const parsed = parseToolsYaml(body);
      const names = Object.keys(parsed);

      // Built-ins always land.
      expect(names).toContain('bash');
      expect(names).toContain('edit');
      expect(names).toContain('log');
      // Operator-selected optionals land.
      expect(names).toContain('websearch');
      expect(names).toContain('mcp:google-workspace');
      // Non-selected optionals are filtered out.
      expect(names).not.toContain('mcp:slack');
      expect(names).not.toContain('mcp:playwright');
      expect(names).not.toContain('mcp:filesystem');

      // Field shape preserved for at least one optional entry.
      const gw = parsed['mcp:google-workspace'];
      expect(gw).toBeDefined();
      expect(gw?.['description']).toBe('Gmail, Calendar, Drive via Google Workspace MCP');
      expect(gw?.['default_transport']).toBe('stdio');
      expect(gw?.['default_auth_env']).toBe('GOOGLE_WORKSPACE_TOKEN');
      expect(gw?.['docker_image']).toBe('praxis/mcp-google-workspace:latest');
    });

    it('writes only built-ins when tools is empty', async () => {
      const result = await seedRole(sampleInput(), tmp);
      expect(result.filesWritten).toContain('lib/tools.yaml');

      const body = await fs.readFile(path.join(tmp, 'lib/tools.yaml'), 'utf-8');
      const parsed = parseToolsYaml(body);
      const names = Object.keys(parsed);

      expect(names.sort()).toEqual(['bash', 'edit', 'log'].sort());
    });
  });

  describe('persona Identity section', () => {
    it('renders working_title and day_to_day bullets when present', async () => {
      const input: SeedInput = {
        ...sampleInput(),
        role_definition: {
          role_name: 'Pat Example',
          working_title: 'Sales lead',
          one_sentence_purpose: 'I drive outbound on the flagship product.',
          day_to_day: 'drafts cold outreach, reviews replies, escalates complex deals',
        },
      };
      await seedRole(input, tmp);
      const persona = await fs.readFile(path.join(tmp, 'persona.md'), 'utf-8');

      expect(persona).toContain('- **Full name**: Pat Example');
      expect(persona).toContain('- **Working title**: Sales lead');
      expect(persona).toContain('- **Role**: I drive outbound on the flagship product.');
      expect(persona).toContain(
        '- **Day-to-day**: drafts cold outreach, reviews replies, escalates complex deals',
      );

      // Order: Working title sits between Full name and Role; Day-to-day sits
      // between Role and Location/Email.
      const fullIdx = persona.indexOf('- **Full name**');
      const titleIdx = persona.indexOf('- **Working title**');
      const roleIdx = persona.indexOf('- **Role**');
      const dayIdx = persona.indexOf('- **Day-to-day**');
      const emailIdx = persona.indexOf('- **Email**');
      expect(fullIdx).toBeLessThan(titleIdx);
      expect(titleIdx).toBeLessThan(roleIdx);
      expect(roleIdx).toBeLessThan(dayIdx);
      expect(dayIdx).toBeLessThan(emailIdx);
    });

    it('omits working_title and day_to_day bullets when absent', async () => {
      // sampleInput() already omits both fields.
      await seedRole(sampleInput(), tmp);
      const persona = await fs.readFile(path.join(tmp, 'persona.md'), 'utf-8');

      expect(persona).not.toContain('Working title');
      expect(persona).not.toContain('Day-to-day');
      // The other bullets still render.
      expect(persona).toContain('- **Full name**: Pat Example');
      expect(persona).toContain('- **Role**:');
    });

    it('omits only the missing field when one is set and the other is not', async () => {
      const input: SeedInput = {
        ...sampleInput(),
        role_definition: {
          role_name: 'Pat Example',
          working_title: 'Sales lead',
          one_sentence_purpose: 'I drive outbound.',
          // day_to_day intentionally omitted
        },
      };
      await seedRole(input, tmp);
      const persona = await fs.readFile(path.join(tmp, 'persona.md'), 'utf-8');

      expect(persona).toContain('- **Working title**: Sales lead');
      expect(persona).not.toContain('Day-to-day');
    });
  });

  describe('CLAUDE.md verbs table', () => {
    it('replaces the placeholder row with one row per captured verb', async () => {
      const input: SeedInput = {
        ...sampleInput(),
        initial_verbs: [
          { slug: 'draft-emails', description: ['Compose outbound drafts.'] },
          { slug: 'review-replies', description: ['Triage and tag inbound replies.'] },
          { slug: 'log-meeting', description: ['Capture meeting outcomes to memory.'] },
        ],
      };
      await seedRole(input, tmp);
      const claude = await fs.readFile(path.join(tmp, 'CLAUDE.md'), 'utf-8');

      expect(claude).not.toContain("(add your role's verbs here)");
      // Built-in rows preserved.
      expect(claude).toContain('| **Persona** | `persona.md`');
      expect(claude).toContain('| **Escalate** | `verbs/escalate.md`');
      // Operator's verbs appear, in the captured order.
      expect(claude).toContain(
        '| **Draft Emails** | `verbs/draft-emails.md` | <unset> | Compose outbound drafts. |',
      );
      expect(claude).toContain(
        '| **Review Replies** | `verbs/review-replies.md` | <unset> | Triage and tag inbound replies. |',
      );
      expect(claude).toContain(
        '| **Log Meeting** | `verbs/log-meeting.md` | <unset> | Capture meeting outcomes to memory. |',
      );
      // Order check.
      const draftIdx = claude.indexOf('Draft Emails');
      const replyIdx = claude.indexOf('Review Replies');
      const logIdx = claude.indexOf('Log Meeting');
      expect(draftIdx).toBeLessThan(replyIdx);
      expect(replyIdx).toBeLessThan(logIdx);
    });

    it('uses <unset> for verbs without description bullets', async () => {
      const input: SeedInput = {
        ...sampleInput(),
        initial_verbs: [{ slug: 'bare-verb', description: [] }],
      };
      await seedRole(input, tmp);
      const claude = await fs.readFile(path.join(tmp, 'CLAUDE.md'), 'utf-8');

      expect(claude).toContain(
        '| **Bare Verb** | `verbs/bare-verb.md` | <unset> | <unset> |',
      );
    });

    it('drops the placeholder row when no verbs are captured', async () => {
      const input: SeedInput = { ...sampleInput(), initial_verbs: [] };
      await seedRole(input, tmp);
      const claude = await fs.readFile(path.join(tmp, 'CLAUDE.md'), 'utf-8');

      expect(claude).not.toContain("(add your role's verbs here)");
      // Built-ins still present.
      expect(claude).toContain('| **Persona** | `persona.md`');
      expect(claude).toContain('| **Escalate** | `verbs/escalate.md`');
    });

    it('returns the body unchanged when the placeholder is absent', () => {
      const customised = '# CLAUDE\n\nNo placeholder here.\n';
      const out = injectVerbsTable(customised, [
        { slug: 'foo', description: ['bar'] },
      ]);
      expect(out).toBe(customised);
    });
  });
});
