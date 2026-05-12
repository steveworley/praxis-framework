import { parsePersona, type Persona } from '@/lib/persona-parser.js';

/**
 * The persona's display name in the four shapes the dashboard needs:
 *
 *   - `full`      — primary display name, "Monika Cosic" or "Sales Lead"
 *                   when no full name was authored. Final fallback "the role".
 *   - `short`     — first word of `full` ("Monika"), used in conversational
 *                   placeholders and inline body copy where a first name reads
 *                   most naturally. Equal to `full` when there's no space.
 *   - `title`     — the operator-authored `working_title` (kept verbatim,
 *                   e.g. "Sales lead"). Undefined when not set.
 *   - `identifier`— the kebab-case slug (`sales-lead`), used for routing /
 *                   config-file naming. Never user-facing copy.
 */
export interface PersonaName {
  full: string;
  short: string;
  title?: string;
  identifier: string;
}

/**
 * Resolve the persona name from `persona.md` Identity fields with a graceful
 * fallback chain. Pure copy resolution — never throws, always returns a
 * usable `PersonaName` (worst case: `{ full: 'the role', short: 'the role',
 * identifier: '' }`).
 *
 * Resolution order for `full`:
 *   1. `full_name` / `name` from Identity (when set and not just the slug)
 *   2. `working_title` (operator's casing preserved)
 *   3. `role_name` slug, title-cased ("sales-lead" → "Sales Lead")
 *   4. `'the role'`
 */
export async function resolvePersonaName(roleHome: string): Promise<PersonaName> {
  const persona = await parsePersona(roleHome);
  return personaNameFrom(persona);
}

/**
 * Same resolution as `resolvePersonaName`, but works from an already-parsed
 * persona — useful for pages that have already loaded the persona for other
 * reasons and want to avoid a second read.
 */
export function personaNameFrom(persona: Persona | null): PersonaName {
  const ident = persona?.identity ?? {};
  const fullName = (ident['full_name'] ?? ident['name'] ?? '').trim();
  const workingTitle = (ident['working_title'] ?? '').trim();
  const roleSlug = (ident['role_name'] ?? ident['role_slug'] ?? '').trim();

  let full: string;
  if (fullName.length > 0 && fullName !== roleSlug) {
    full = fullName;
  } else if (workingTitle.length > 0) {
    full = workingTitle;
  } else if (roleSlug.length > 0) {
    full = titleCaseSlug(roleSlug);
  } else {
    full = 'the role';
  }

  const short = firstWord(full);

  const out: PersonaName = { full, short, identifier: roleSlug };
  if (workingTitle.length > 0) out.title = workingTitle;
  return out;
}

function firstWord(value: string): string {
  const idx = value.indexOf(' ');
  return idx < 0 ? value : value.slice(0, idx);
}

function titleCaseSlug(slug: string): string {
  return slug
    .split('-')
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}
