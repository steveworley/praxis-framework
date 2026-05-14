import fs from 'node:fs/promises';
import path from 'node:path';

export interface VoiceTrait {
  /** Canonical name from the trait library (lowercase token like `direct`). */
  trait: string;
  /**
   * Free-text descriptors qualifying *how* the trait should manifest. The
   * persona renderer lays each one out either inline (single qualifier
   * follows ` -- `) or as nested bullets under the trait (multi-qualifier),
   * and the parser collapses both back into this array.
   */
  qualifiers: string[];
}

export interface PersonaInitialVerb {
  slug: string;
  /**
   * Bullet-shaped body content for the verb. The renderer emits each entry
   * either inline (single bullet follows ` -- `) or as nested sub-bullets
   * under the slug (multi-bullet), and the parser collapses both back into
   * this array. Empty array means the slug has no authored body content.
   */
  description: string[];
}

export interface Persona {
  identity: Record<string, string>;
  voice: VoiceTrait[];
  capabilities: string[];
  /**
   * First-person "I'm responsible for…" statements. The bridge between
   * capabilities (what the role CAN do) and success criteria (how the role
   * is judged). Free-text bullet list parsed from `## Accountabilities`.
   */
  accountabilities: string[];
  /**
   * Observable, falsifiable outcome bullets. The role uses these for
   * end-of-run self-assessment. Parsed from `## Success criteria`.
   */
  success_criteria: string[];
  inhibitions: string[];
  /**
   * Stub verbs — only emitted by the research-engine handoff draft, not the
   * standard `persona.md`. Empty array for normal seeded roles.
   */
  initial_verbs: PersonaInitialVerb[];
}

/**
 * Parse persona.md into the structured shape the dashboard renders.
 * Mirrors the Python `_parse_persona` regexes exactly so the wizard-emitted
 * persona round-trips identically.
 */
export async function parsePersona(roleHome: string): Promise<Persona> {
  const personaPath = path.join(roleHome, 'persona.md');
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
 * under `persona.md`.
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
    // Two emitted shapes from the seeder:
    //   - **direct** -- short sentences, no hedging        (inline single qualifier)
    //   - **direct**                                       (multi-qualifier — followed by indented sub-bullets)
    //       - short sentences, no hedging
    //       - calls out tradeoffs upfront
    // The bare-trait form (no qualifiers, library description fallback)
    // looks identical to the inline-single-qualifier form; round-tripping
    // it as a single qualifier is lossy but acceptable for the wizard.
    const lines = voiceSection.split('\n');
    let current: { trait: string; qualifiers: string[] } | null = null;
    for (const rawLine of lines) {
      const inline = /^-\s+\*\*([^*]+)\*\*\s*--\s*(.+)$/.exec(rawLine.trim());
      if (inline) {
        if (current) out.voice.push(current);
        current = {
          trait: (inline[1] ?? '').trim(),
          qualifiers: [(inline[2] ?? '').trim()].filter((q) => q.length > 0),
        };
        continue;
      }
      const headerOnly = /^-\s+\*\*([^*]+)\*\*\s*$/.exec(rawLine.trim());
      if (headerOnly) {
        if (current) out.voice.push(current);
        current = { trait: (headerOnly[1] ?? '').trim(), qualifiers: [] };
        continue;
      }
      // Indented sub-bullet — a qualifier under the current trait.
      const sub = /^\s+-\s+(.+)$/.exec(rawLine);
      if (sub && current) {
        const text = (sub[1] ?? '').trim();
        if (text.length > 0) current.qualifiers.push(text);
        continue;
      }
    }
    if (current) out.voice.push(current);
  }

  const capabilitiesSection = extractSection(text, 'Capabilities');
  if (capabilitiesSection) {
    for (const item of bulletItems(capabilitiesSection)) {
      out.capabilities.push(item);
    }
  }

  const accountabilitiesSection = extractSection(text, 'Accountabilities');
  if (accountabilitiesSection) {
    for (const item of bulletItems(accountabilitiesSection)) {
      out.accountabilities.push(item);
    }
  }

  const successCriteriaSection = extractSection(text, 'Success criteria');
  if (successCriteriaSection) {
    for (const item of bulletItems(successCriteriaSection)) {
      out.success_criteria.push(item);
    }
  }

  const inhibitionsSection = extractSection(text, 'Hard inhibitions');
  if (inhibitionsSection) {
    for (const item of bulletItems(inhibitionsSection)) {
      out.inhibitions.push(item);
    }
  }

  // Optional draft-only section: `## Initial verbs`. Mirrors the voice
  // section's two emitted shapes:
  //   - **slug** -- single bullet                    (inline, single-bullet)
  //   - **slug**                                     (multi-bullet — sub-bullets follow)
  //       - bullet one
  //       - bullet two
  //   - **slug**                                     (no bullets — empty description)
  const verbsSection = extractSection(text, 'Initial verbs');
  if (verbsSection) {
    const lines = verbsSection.split('\n');
    let current: { slug: string; description: string[] } | null = null;
    for (const rawLine of lines) {
      const inline = /^-\s+\*\*([^*]+)\*\*\s*--\s*(.+)$/.exec(rawLine.trim());
      if (inline) {
        if (current) out.initial_verbs.push(current);
        current = {
          slug: (inline[1] ?? '').trim(),
          description: [(inline[2] ?? '').trim()].filter((d) => d.length > 0),
        };
        continue;
      }
      const headerOnly = /^-\s+\*\*([^*]+)\*\*\s*$/.exec(rawLine.trim());
      if (headerOnly) {
        if (current) out.initial_verbs.push(current);
        current = { slug: (headerOnly[1] ?? '').trim(), description: [] };
        continue;
      }
      const sub = /^\s+-\s+(.+)$/.exec(rawLine);
      if (sub && current) {
        const bullet = (sub[1] ?? '').trim();
        if (bullet.length > 0) current.description.push(bullet);
        continue;
      }
    }
    if (current) out.initial_verbs.push(current);
    // Drop any malformed entry that ended up without a slug.
    out.initial_verbs = out.initial_verbs.filter((v) => v.slug.length > 0);
  }

  return out;
}

function emptyPersona(): Persona {
  return {
    identity: {},
    voice: [],
    capabilities: [],
    accountabilities: [],
    success_criteria: [],
    inhibitions: [],
    initial_verbs: [],
  };
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
