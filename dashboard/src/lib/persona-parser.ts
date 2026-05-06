import fs from 'node:fs/promises';
import path from 'node:path';

export interface VoiceTrait {
  label: string;
  detail: string;
}

export interface PersonaInitialAgent {
  slug: string;
  purpose: string;
}

export interface Persona {
  identity: Record<string, string>;
  voice: VoiceTrait[];
  capabilities: string[];
  inhibitions: string[];
  /**
   * Stub agents — only emitted by the research-engine handoff draft, not the
   * standard `agents/persona.md`. Empty array for normal seeded roles.
   */
  initial_agents: PersonaInitialAgent[];
}

/**
 * Parse agents/persona.md into the structured shape the dashboard renders.
 * Mirrors the Python `_parse_persona` regexes exactly so the wizard-emitted
 * persona round-trips identically.
 */
export async function parsePersona(roleHome: string): Promise<Persona> {
  const personaPath = path.join(roleHome, 'agents', 'persona.md');
  let text: string;
  try {
    text = await fs.readFile(personaPath, 'utf-8');
  } catch {
    return emptyPersona();
  }
  return parsePersonaText(text);
}

/**
 * Parse persona-shaped markdown directly. Used by the research-engine draft
 * loader so it can reuse the same parser without staging the draft on disk
 * under `agents/persona.md`.
 */
export function parsePersonaText(text: string): Persona {
  const out = emptyPersona();
  if (text.length === 0) return out;

  const identitySection = extractSection(text, 'Identity');
  if (identitySection) {
    const re = /-\s+\*\*([\w \-]+)\*\*:\s*(.+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(identitySection)) !== null) {
      const key = (m[1] ?? '').trim().toLowerCase().replace(/ /g, '_');
      const value = (m[2] ?? '').trim();
      if (key.length > 0) out.identity[key] = value;
    }
  }

  const voiceSection = extractSection(text, 'Voice & Personality');
  if (voiceSection) {
    for (const rawLine of voiceSection.split('\n')) {
      const line = rawLine.trim();
      const m = /^-\s+\*\*([^*]+)\*\*\s*--\s*(.+)$/.exec(line);
      if (m) {
        out.voice.push({ label: (m[1] ?? '').trim(), detail: (m[2] ?? '').trim() });
      }
    }
  }

  const capabilitiesSection = extractSection(text, 'Capabilities');
  if (capabilitiesSection) {
    for (const item of bulletItems(capabilitiesSection)) {
      out.capabilities.push(item);
    }
  }

  const inhibitionsSection = extractSection(text, 'Hard inhibitions');
  if (inhibitionsSection) {
    for (const item of bulletItems(inhibitionsSection)) {
      out.inhibitions.push(item);
    }
  }

  // Optional draft-only section: `## Initial agents` with `- **slug** -- purpose`.
  const agentsSection = extractSection(text, 'Initial agents');
  if (agentsSection) {
    for (const rawLine of agentsSection.split('\n')) {
      const line = rawLine.trim();
      const m = /^-\s+\*\*([^*]+)\*\*\s*--\s*(.+)$/.exec(line);
      if (m) {
        const slug = (m[1] ?? '').trim();
        const purpose = (m[2] ?? '').trim();
        if (slug && purpose) out.initial_agents.push({ slug, purpose });
      }
    }
  }

  return out;
}

function emptyPersona(): Persona {
  return { identity: {}, voice: [], capabilities: [], inhibitions: [], initial_agents: [] };
}

function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`);
  const m = re.exec(text);
  return m ? (m[1] ?? null) : null;
}

function* bulletItems(section: string): Generator<string> {
  for (const rawLine of section.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('- ')) {
      yield line.slice(2).trim();
    }
  }
}
