import { z } from 'zod';

export const Organisation = z.object({
  name: z.string().min(1),
  website: z.string().optional(),
  sector: z.string().optional(),
  size: z.enum(['solo', 'small', 'mid', 'large', 'enterprise']).optional(),
  description: z.string().optional(),
  moats: z.string().optional(),
  customer_profile: z.string().optional(),
});

export const RoleDefinition = z.object({
  role_name: z.string().min(1),
  working_title: z.string().optional(),
  one_sentence_purpose: z.string().min(1),
  day_to_day: z.string().optional(),
});

export const VoiceTrait = z.object({
  /** Canonical name from the trait library (`cli/src/lib/traits.ts`). */
  trait: z.string().min(1),
  /** Free-text descriptors qualifying *how* the trait should manifest. */
  qualifiers: z.array(z.string()).default([]),
});

export const InitialVerb = z.object({
  /** Filename-shaped slug (lowercase letters, digits, hyphens; starts with a letter). */
  slug: z.string().min(1),
  /**
   * Bullet-shaped body content for the verb file. 0-N free-text strings;
   * each renders as a `- bullet` line in `verbs/<slug>.md`. An empty array
   * is valid — the seeded file falls back to a bare heading + TODO marker.
   */
  description: z.array(z.string()).default([]),
});

export const Form = z.object({
  organisation: Organisation.partial(),
  role_definition: RoleDefinition.partial(),
  path: z.enum(['research', 'manual', 'unset']).default('unset'),
  // Optional MCP capability names selected during the tool-selection step.
  // Built-in capabilities (always_available in the catalog) are not stored
  // here — they're implicit. v2 will extend each entry with per-MCP transport
  // and auth overrides; v1 stores names only.
  tools: z.array(z.string()).default([]),
  // Voice & personality — canonical trait name (from the curated library at
  // `cli/src/lib/traits.ts`) plus 0-N free-text qualifiers describing how the
  // trait should manifest.
  voice_traits: z.array(VoiceTrait).default([]),
  // Action-shaped responsibilities for this role.
  capabilities: z.array(z.string()).default([]),
  // First-person "I'm responsible for …" statements — bridges between what
  // the role CAN do and what it drives TOWARD.
  accountabilities: z.array(z.string()).default([]),
  // Observable, falsifiable outcomes the role's performance is judged
  // against. Used for end-of-run self-assessment.
  success_criteria: z.array(z.string()).default([]),
  // Hard "never do" rules, intentionally absolute.
  inhibitions: z.array(z.string()).default([]),
  // First verbs the role will run; slug is filename-shaped.
  initial_verbs: z.array(InitialVerb).default([]),
});

export type Organisation = z.infer<typeof Organisation>;
export type RoleDefinition = z.infer<typeof RoleDefinition>;
export type VoiceTrait = z.infer<typeof VoiceTrait>;
export type InitialVerb = z.infer<typeof InitialVerb>;
export type Form = z.infer<typeof Form>;

export const emptyForm = (): Form => ({
  organisation: {},
  role_definition: {},
  path: 'unset',
  tools: [],
  voice_traits: [],
  capabilities: [],
  accountabilities: [],
  success_criteria: [],
  inhibitions: [],
  initial_verbs: [],
});
