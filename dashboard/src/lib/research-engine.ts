import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Research engine abstraction. Today the only implementation is a file-based
 * handoff to Claude Code (`HandoffEngine`) — the wizard writes a brief into
 * `.praxis/research-brief.md`, the operator runs `claude` in the role repo,
 * Claude reads the brief and writes `.praxis/persona-draft.md` back. The
 * dashboard polls for the draft and parses it into the wizard form.
 *
 * The interface is shaped so a future `ClaudeApiEngine` (synchronous, returns
 * `{ kind: 'draft', persona }` directly) can drop in behind `getResearchEngine()`
 * with no caller changes.
 */

export interface OrganisationContext {
  name: string;
  website?: string;
  sector?: string;
  size?: 'solo' | 'small' | 'mid' | 'large' | 'enterprise';
  description?: string;
  moats?: string;
  customer_profile?: string;
}

export interface RoleDefinitionContext {
  role_name: string;
  working_title?: string;
  one_sentence_purpose: string;
  day_to_day?: string;
}

export interface ResearchContext {
  organisation: OrganisationContext;
  role_definition: RoleDefinitionContext;
}

export interface PersonaIdentity {
  full_name: string;
  role?: string;
  location?: string;
  reports_to?: string;
  email?: string;
}

export interface PersonaDraftAgent {
  slug: string;
  purpose: string;
}

export interface PersonaDraft {
  identity: PersonaIdentity;
  voice_traits: { label: string; detail: string }[];
  capabilities: string[];
  inhibitions: string[];
  initial_agents: PersonaDraftAgent[];
}

export type ResearchResult =
  | { kind: 'handoff'; brief_path: string; prompt: string; expected_draft_path: string }
  | { kind: 'draft'; persona: PersonaDraft };

export interface ResearchEngineEnv {
  roleHome: string;
}

export interface ResearchEngine {
  propose(ctx: ResearchContext, env: ResearchEngineEnv): Promise<ResearchResult>;
}

const PRAXIS_DIR = '.praxis';
const BRIEF_FILE = 'research-brief.md';
const DRAFT_FILE = 'persona-draft.md';

/**
 * File-based handoff. The brief is the prompt — Claude reads
 * `.praxis/research-brief.md` directly in its working directory.
 */
export class HandoffEngine implements ResearchEngine {
  async propose(ctx: ResearchContext, env: ResearchEngineEnv): Promise<ResearchResult> {
    const praxisDir = path.join(env.roleHome, PRAXIS_DIR);
    await fs.mkdir(praxisDir, { recursive: true });

    const briefAbs = path.join(praxisDir, BRIEF_FILE);
    const briefBody = renderBrief(ctx);
    await fs.writeFile(briefAbs, briefBody, 'utf-8');

    const briefRel = path.posix.join(PRAXIS_DIR, BRIEF_FILE);
    const draftRel = path.posix.join(PRAXIS_DIR, DRAFT_FILE);
    const prompt = `Read ${briefRel} and follow it. Write your output to ${draftRel}.`;

    return {
      kind: 'handoff',
      brief_path: briefRel,
      prompt,
      expected_draft_path: draftRel,
    };
  }
}

export function getResearchEngine(): ResearchEngine {
  const which = process.env['PRAXIS_RESEARCH_ENGINE'] ?? 'handoff';
  if (which === 'handoff') return new HandoffEngine();
  // Future: 'claude-api' → return new ClaudeApiEngine(...);
  throw new Error(`Unknown research engine: ${which}`);
}

function renderBrief(ctx: ResearchContext): string {
  const { organisation: org, role_definition: role } = ctx;
  const lines: string[] = [];

  lines.push(`# Research brief: design a role for ${org.name}`);
  lines.push('');
  lines.push(
    "You are a researcher helping design a role-based agent for an organisation. Read this brief, do whatever research you need (web search, reading their site), and write a populated persona draft to `.praxis/persona-draft.md` in the format specified at the bottom of this file.",
  );
  lines.push('');
  lines.push('## The organisation');
  lines.push('');
  lines.push(`**Name**: ${org.name}`);
  if (org.website) lines.push(`**Website**: ${org.website}`);
  if (org.sector) lines.push(`**Sector**: ${org.sector}`);
  if (org.size) lines.push(`**Size**: ${org.size}`);
  lines.push('');
  if (org.description) {
    lines.push(org.description);
    lines.push('');
  }
  if (org.moats) {
    lines.push('### What makes them different');
    lines.push('');
    lines.push(org.moats);
    lines.push('');
  }
  if (org.customer_profile) {
    lines.push('### Who the role engages with');
    lines.push('');
    lines.push(org.customer_profile);
    lines.push('');
  }
  lines.push('## The role we want');
  lines.push('');
  lines.push(`**Working name**: ${role.role_name}`);
  if (role.working_title) lines.push(`**Title**: ${role.working_title}`);
  lines.push(`**Purpose**: ${role.one_sentence_purpose}`);
  lines.push('');
  if (role.day_to_day) {
    lines.push('### Day-to-day');
    lines.push('');
    lines.push(role.day_to_day);
    lines.push('');
  }
  lines.push('## Your task');
  lines.push('');
  lines.push(`1. Research ${org.name} — understand their public positioning, customer base, competitive context, what their pricing / sales motion looks like, what tone they use publicly.`);
  lines.push('2. Identify the moats they actually have (not aspirational ones — observable ones).');
  lines.push('3. Design a role that *fits* — voice that matches their public tone, capabilities that play to their moats, inhibitions that protect against the failure modes their customers care about.');
  lines.push('4. Write the result as `.praxis/persona-draft.md` in the exact markdown format shown below.');
  lines.push('5. Surface uncertainty rather than papering over it. If you could not find specific moat evidence, say so — the operator will fill it in during review.');
  lines.push('');
  lines.push('## Constraints');
  lines.push('');
  lines.push('- 1–8 voice traits.');
  lines.push('- 1–10 capabilities, written in first person ("I can…").');
  lines.push('- 1–10 inhibitions, written as "I never…".');
  lines.push('- 0–5 initial agents.');
  lines.push('- All content English. Voice traits should be observable behaviours, not adjectives.');
  lines.push('');
  lines.push('## Required output format');
  lines.push('');
  lines.push('Write `.praxis/persona-draft.md` with these exact section headings (the dashboard parses them):');
  lines.push('');
  lines.push('````markdown');
  lines.push(`# Persona — ${role.role_name}`);
  lines.push('');
  lines.push('## Identity');
  lines.push('');
  lines.push('- **Full name**: <name>');
  lines.push('- **Role**: <role title>');
  lines.push('- **Location**: <city / region>');
  lines.push('- **Reports to**: <operator name>');
  lines.push('- **Email**: <primary email>');
  lines.push('');
  lines.push('## Voice & Personality');
  lines.push('');
  lines.push('- **<Trait label>** -- <observable behaviour>');
  lines.push('- **<Trait label>** -- <observable behaviour>');
  lines.push('');
  lines.push('## Capabilities');
  lines.push('');
  lines.push('- I can <capability>');
  lines.push('- I can <capability>');
  lines.push('');
  lines.push('## Hard inhibitions');
  lines.push('');
  lines.push('- I never <inhibition>');
  lines.push('- I never <inhibition>');
  lines.push('');
  lines.push('## Initial agents');
  lines.push('');
  lines.push('- **agent-slug** -- <one-line purpose>');
  lines.push('- **agent-slug** -- <one-line purpose>');
  lines.push('');
  lines.push('# Notes for the operator');
  lines.push('');
  lines.push('<sources, caveats, anything worth surfacing>');
  lines.push('````');
  lines.push('');
  return lines.join('\n');
}
