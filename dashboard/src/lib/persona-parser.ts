import fs from 'node:fs/promises';
import path from 'node:path';

export interface VoiceTrait {
  label: string;
  detail: string;
}

export interface Persona {
  identity: Record<string, string>;
  voice: VoiceTrait[];
  capabilities: string[];
  inhibitions: string[];
}

/**
 * Parse agents/persona.md into the structured shape the dashboard renders.
 * Mirrors the Python `_parse_persona` regexes exactly so the wizard-emitted
 * persona round-trips identically.
 */
export async function parsePersona(roleHome: string): Promise<Persona> {
  const personaPath = path.join(roleHome, 'agents', 'persona.md');
  const out: Persona = { identity: {}, voice: [], capabilities: [], inhibitions: [] };
  let text: string;
  try {
    text = await fs.readFile(personaPath, 'utf-8');
  } catch {
    return out;
  }
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

  return out;
}

function extractSection(text: string, heading: string): string | null {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`## ${escaped}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`);
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
