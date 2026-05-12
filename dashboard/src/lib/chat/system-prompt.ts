import fs from 'node:fs/promises';
import path from 'node:path';

import { loadAutonomy, type AutonomySurface } from '@/lib/autonomy-loader.js';
import { parsePersona } from '@/lib/persona-parser.js';
import { loadVerbs, type VerbSummary } from '@/lib/verbs-loader.js';

import { personaNameFrom } from './persona-name.js';

/**
 * Surfaces that are constitutional — the model may NOT edit these directly,
 * regardless of what `lib/autonomy.yaml` says. These mirror the framework's
 * documented gating model (see docs/autonomy.md).
 */
const CONSTITUTIONAL_GATED: readonly string[] = [
  'persona.md',
  'verbs/*.md',
  'CLAUDE.md',
];

/**
 * Assemble the system prompt for the chat surface. The prompt makes the model
 * embody the role: voice from persona, available verbs, hard rules from
 * CLAUDE.md, autonomy stance, and tool catalog.
 *
 * Throws only if `persona.md` is missing — that's a real "no role" error and
 * the API surface upstream should render the missing-role UI. Every other
 * source file is optional; missing ones are quietly elided.
 */
export async function buildSystemPrompt(roleHome: string): Promise<string> {
  const persona = await parsePersona(roleHome);
  const personaText = await readPersonaBody(roleHome);
  if (personaText === null) {
    throw new Error(`persona.md not found at ${roleHome}`);
  }

  // Give the model a self-image consistent with how the operator addresses it
  // in chat copy — by persona name, optionally suffixed with the working
  // title for context. Falls back through the same chain the UI uses.
  const name = personaNameFrom(persona);
  const opener = name.title ? `You are ${name.full} (${name.title}).` : `You are ${name.full}.`;

  const sections: string[] = [];
  sections.push(opener);
  sections.push('');
  sections.push(personaText);

  const verbsBlock = await renderVerbsSection(roleHome);
  if (verbsBlock) sections.push('', verbsBlock);

  const hardRulesBlock = await renderHardRulesSection(roleHome);
  if (hardRulesBlock) sections.push('', hardRulesBlock);

  const autonomyBlock = await renderAutonomySection(roleHome);
  if (autonomyBlock) sections.push('', autonomyBlock);

  const toolsBlock = await renderToolsSection(roleHome);
  if (toolsBlock) sections.push('', toolsBlock);

  sections.push('', '---', '');
  sections.push(
    'You are speaking with the operator who owns you. They may:',
    '- Ask questions about your work, decisions, or memory',
    '- Give you tasks or feedback',
    '- Upload documents for context',
    '- Refine your role over time',
    '',
    'Respond in your voice. You have five growth tools available to you in this conversation:',
    '- `write_memory` — capture an observation worth remembering into your notebook',
    '- `create_escalation` — file a help / improvement / proposed_skill ask for your operator',
    '- `propose_verb` — draft a new playbook into verbs/proposed/ for operator review',
    '- `append_entry` — append an entry to an operator-opened append-only YAML surface (see above)',
    '- `log_decision` — log a non-trivial decision to your audit trail',
    '',
    'Use them sparingly and only when the observation, ask, or decision is genuinely worth capturing. Default to writing for memory (your operator prunes); be selective for the other tools. If a tool refuses (gated surface, duplicate slug, malformed input, max_pending reached), the refusal message tells you why — adjust and try again, or surface the friction to your operator in your reply. For `append_entry`, a max_pending refusal is your signal to file an `improvement` escalation asking for compaction.',
  );

  return sections.join('\n');
}

/**
 * Read `persona.md` with the leading H1 stripped — the H1 is template noise
 * ("# Persona — {ROLE_NAME}") that we replace with the cleaner "You are X."
 * opener. Returns null if the file doesn't exist.
 */
async function readPersonaBody(roleHome: string): Promise<string | null> {
  const personaPath = path.join(roleHome, 'persona.md');
  let text: string;
  try {
    text = await fs.readFile(personaPath, 'utf-8');
  } catch {
    return null;
  }
  return stripLeadingH1(text).trim();
}

function stripLeadingH1(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i]!.trim().length === 0) i += 1;
  if (i < lines.length && /^#\s+/.test(lines[i]!)) {
    i += 1;
  }
  return lines.slice(i).join('\n');
}

async function renderVerbsSection(roleHome: string): Promise<string | null> {
  const verbs = await loadVerbs(roleHome);
  if (verbs.live.length === 0) return null;

  const lines: string[] = ['## Available verbs', ''];
  for (const verb of verbs.live) {
    const slug = verbSlug(verb);
    const summary = await readVerbOneLiner(roleHome, verb);
    lines.push(`- ${slug}: ${summary}`);
  }
  return lines.join('\n');
}

function verbSlug(verb: VerbSummary): string {
  // verb.file is `escalate.md` or `proposed/foo.md` — strip dir + extension.
  return path.basename(verb.file, '.md');
}

/**
 * Pull a one-liner from the verb file: prefer a `summary:` / `description:`
 * frontmatter field, otherwise fall back to the first non-empty line of the
 * H1's first paragraph, otherwise the verb label.
 */
async function readVerbOneLiner(roleHome: string, verb: VerbSummary): Promise<string> {
  const filePath = path.join(roleHome, 'verbs', verb.file);
  let text: string;
  try {
    text = await fs.readFile(filePath, 'utf-8');
  } catch {
    return verb.label;
  }

  // Try frontmatter first.
  const fm = /^---\s*\n([\s\S]*?)\n---\s*\n/.exec(text);
  if (fm) {
    for (const rawLine of (fm[1] ?? '').split('\n')) {
      const m = /^\s*(summary|description|purpose)\s*:\s*(.+?)\s*$/i.exec(rawLine);
      if (m) {
        return stripWrappingQuotes((m[2] ?? '').trim());
      }
    }
  }

  // Fallback: first non-heading, non-blank line after the H1.
  const body = fm ? text.slice(fm[0].length) : text;
  const lines = body.split('\n');
  let seenH1 = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      if (!seenH1) seenH1 = true;
      continue;
    }
    return line;
  }
  return verb.label;
}

function stripWrappingQuotes(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

async function renderHardRulesSection(roleHome: string): Promise<string | null> {
  const claudePath = path.join(roleHome, 'CLAUDE.md');
  let text: string;
  try {
    text = await fs.readFile(claudePath, 'utf-8');
  } catch {
    return null;
  }
  const section = extractMarkdownSection(text, /^##\s+Hard rules\b.*$/im);
  if (!section || section.trim().length === 0) return null;
  return ['## Hard rules', '', section.trim()].join('\n');
}

/**
 * Slice out a markdown section starting at the line matching `headingRegex`
 * (a `## …` line) up to the next heading of the same level or higher (or EOF).
 * Returns the body content (heading line excluded).
 */
function extractMarkdownSection(text: string, headingRegex: RegExp): string | null {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingRegex.test(lines[i] ?? '')) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^#{1,2}\s+/.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

async function renderAutonomySection(roleHome: string): Promise<string | null> {
  const autonomy = await loadAutonomy(roleHome);
  const openSurfaces: AutonomySurface[] =
    autonomy?.surfaces.filter((s) => s.mode !== 'gated') ?? [];

  const lines: string[] = ['## Autonomy'];
  if (openSurfaces.length > 0) {
    lines.push('', 'You may edit these surfaces directly (autonomous edits allowed):');
    for (const s of openSurfaces) {
      lines.push(`- ${s.path} (mode: ${s.mode})`);
    }
  }
  lines.push(
    '',
    'You may NOT edit these surfaces directly — they require operator approval via escalations/:',
  );
  for (const item of CONSTITUTIONAL_GATED) {
    lines.push(`- ${item}`);
  }
  lines.push('- lib/* (except where listed above)');

  const appendOnly = openSurfaces.filter((s) => s.mode === 'append-only');
  if (appendOnly.length > 0) {
    lines.push('', '### Operator-opened append-only surfaces');
    lines.push(
      '',
      'You may append (but not edit existing entries) to these files using `append_entry`:',
    );
    for (const s of appendOnly) {
      const meta: string[] = [];
      if (s.root_key) meta.push(`root_key: ${s.root_key}`);
      if (s.unique_by) meta.push(`unique_by: ${s.unique_by}`);
      if (s.max_pending !== undefined) meta.push(`max_pending: ${s.max_pending}`);
      const metaPart = meta.length > 0 ? ` (${meta.join(', ')})` : '';
      lines.push(`- \`${s.path}\`${metaPart}`);
      if (s.why) {
        for (const whyLine of s.why.split('\n')) {
          if (whyLine.trim().length === 0) continue;
          lines.push(`  ${whyLine.trim()}`);
        }
      }
    }
  }
  return lines.join('\n');
}

async function renderToolsSection(roleHome: string): Promise<string | null> {
  const toolsPath = path.join(roleHome, 'lib', 'tools.yaml');
  let text: string;
  try {
    text = await fs.readFile(toolsPath, 'utf-8');
  } catch {
    return null;
  }
  const tools = parseToolsYaml(text);
  if (tools.length === 0) return null;

  const lines: string[] = ['## Available tools', ''];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
  }
  return lines.join('\n');
}

interface ToolEntry {
  name: string;
  description: string;
}

/**
 * Hand-rolled parser for the subset of `tools.yaml` we need: top-level
 * `capabilities:` map, each child key is a tool name with a nested
 * `description:` field. Anything else in the file is ignored.
 */
export function parseToolsYaml(text: string): ToolEntry[] {
  const lines = text.split('\n');
  const tools: ToolEntry[] = [];

  let inCapabilities = false;
  let capIndent = -1;
  let currentName: string | null = null;
  let currentNameIndent = -1;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const leading = rawLine.length - rawLine.trimStart().length;

    if (!inCapabilities) {
      if (/^capabilities\s*:\s*$/.test(trimmed) && leading === 0) {
        inCapabilities = true;
        capIndent = 0;
      }
      continue;
    }

    // A new top-level key breaks out of capabilities.
    if (leading <= capIndent && /:\s*$/.test(trimmed) && !trimmed.startsWith('-')) {
      inCapabilities = false;
      currentName = null;
      continue;
    }

    // A tool-name line: `  name:` at greater indent than `capabilities:`.
    const nameMatch = /^([A-Za-z_][\w:.-]*)\s*:\s*$/.exec(trimmed);
    if (nameMatch && (currentNameIndent < 0 || leading <= currentNameIndent)) {
      currentName = nameMatch[1] ?? null;
      currentNameIndent = leading;
      continue;
    }

    if (currentName) {
      const descMatch = /^description\s*:\s*(.+?)\s*$/i.exec(trimmed);
      if (descMatch) {
        const desc = stripWrappingQuotes((descMatch[1] ?? '').trim());
        if (desc.length > 0) {
          tools.push({ name: currentName, description: desc });
        }
        currentName = null;
      }
    }
  }

  return tools;
}
