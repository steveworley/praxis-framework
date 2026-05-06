import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HandoffEngine, getResearchEngine, type ResearchContext } from './research-engine.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-research-'));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

const ctx: ResearchContext = {
  organisation: {
    name: 'Quant',
    website: 'https://quantcdn.io',
    sector: 'CDN / edge',
    size: 'small',
    description: 'CDN and edge platform for security-conscious teams.',
    moats: 'IRAP-assessed Australian sovereign hosting.',
    customer_profile: 'Government and regulated enterprise.',
  },
  role_definition: {
    role_name: 'Sam Parker',
    working_title: 'BD agent',
    one_sentence_purpose: 'Owns sales-side outreach for Quant.',
    day_to_day: 'Cold campaigns, manual lead intake, weekly account reads.',
  },
};

describe('HandoffEngine', () => {
  it('writes a research brief and returns the handoff metadata', async () => {
    const engine = new HandoffEngine();
    const result = await engine.propose(ctx, { roleHome: tempDir });

    expect(result.kind).toBe('handoff');
    if (result.kind !== 'handoff') return;
    expect(result.brief_path).toBe('.praxis/research-brief.md');
    expect(result.expected_draft_path).toBe('.praxis/persona-draft.md');
    expect(result.prompt).toContain('.praxis/research-brief.md');
    expect(result.prompt).toContain('.praxis/persona-draft.md');

    const briefAbs = path.join(tempDir, '.praxis', 'research-brief.md');
    const briefBody = await fs.readFile(briefAbs, 'utf-8');
    expect(briefBody).toContain('Research brief: design a role for Quant');
    expect(briefBody).toContain('https://quantcdn.io');
    expect(briefBody).toContain('IRAP-assessed Australian sovereign hosting.');
    expect(briefBody).toContain('Owns sales-side outreach for Quant.');
    expect(briefBody).toContain('## Required output format');
    expect(briefBody).toContain('## Initial agents');
  });

  it('creates the .praxis directory if it does not exist', async () => {
    const engine = new HandoffEngine();
    await engine.propose(ctx, { roleHome: tempDir });
    const stat = await fs.stat(path.join(tempDir, '.praxis'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('omits optional org fields cleanly when not provided', async () => {
    const minimalCtx: ResearchContext = {
      organisation: { name: 'Acme' },
      role_definition: {
        role_name: 'Bot',
        one_sentence_purpose: 'Does the thing.',
      },
    };
    const engine = new HandoffEngine();
    await engine.propose(minimalCtx, { roleHome: tempDir });
    const briefBody = await fs.readFile(path.join(tempDir, '.praxis', 'research-brief.md'), 'utf-8');
    expect(briefBody).toContain('**Name**: Acme');
    expect(briefBody).not.toContain('**Website**');
    expect(briefBody).not.toContain('**Sector**');
  });
});

describe('getResearchEngine', () => {
  it('defaults to HandoffEngine', () => {
    const prev = process.env['PRAXIS_RESEARCH_ENGINE'];
    delete process.env['PRAXIS_RESEARCH_ENGINE'];
    try {
      const engine = getResearchEngine();
      expect(engine).toBeInstanceOf(HandoffEngine);
    } finally {
      if (prev !== undefined) process.env['PRAXIS_RESEARCH_ENGINE'] = prev;
    }
  });

  it('throws on unknown engine names', () => {
    const prev = process.env['PRAXIS_RESEARCH_ENGINE'];
    process.env['PRAXIS_RESEARCH_ENGINE'] = 'does-not-exist';
    try {
      expect(() => getResearchEngine()).toThrow(/Unknown research engine/);
    } finally {
      if (prev === undefined) delete process.env['PRAXIS_RESEARCH_ENGINE'];
      else process.env['PRAXIS_RESEARCH_ENGINE'] = prev;
    }
  });
});
