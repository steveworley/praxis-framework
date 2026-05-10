import { z } from 'zod';

/**
 * Seed input schemas — the shape the dashboard wizard and the CLI both
 * produce on submit. The CLI uses a permissive `Form` schema during the
 * wizard (every field optional / partial) and tightens to this shape at
 * submit time once the operator has walked the whole flow. The dashboard
 * has historically used the same shape under the name `SeedRequest`.
 *
 * The seed package validates against this schema before writing anything
 * to disk, so a malformed input fails fast with a typed Zod error rather
 * than producing a half-populated role.
 */

export const SeedVerbSchema = z.object({
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z][a-z0-9-]*$/, 'slug must be lowercase kebab-case'),
  /**
   * Bullet-shaped body content for the seeded `verbs/<slug>.md` file. Each
   * entry renders as one `- bullet` line under the verb's heading. Optional —
   * an empty array seeds a stub file with a TODO marker so the operator can
   * fill it in later. Capped at 6 to keep the seeded body skim-readable.
   */
  description: z.array(z.string().min(1).max(280)).max(6).default([]),
});

export const OrganisationSchema = z.object({
  name: z.string().min(1).max(160),
  website: z.string().max(240).optional(),
  sector: z.string().max(160).optional(),
  size: z.enum(['solo', 'small', 'mid', 'large', 'enterprise']).optional(),
  description: z.string().max(1200).optional(),
  moats: z.string().max(1200).optional(),
  customer_profile: z.string().max(1200).optional(),
});

export const RoleDefinitionSchema = z.object({
  role_name: z.string().min(1).max(120),
  working_title: z.string().max(120).optional(),
  one_sentence_purpose: z.string().min(1).max(280),
  day_to_day: z.string().max(1200).optional(),
});

export const VoiceTraitSchema = z.object({
  /**
   * Canonical name from the framework's trait library. Lowercase token like
   * `direct` or `curious` — describes *what* the trait is. The framework
   * doesn't enforce membership in a specific catalog at the schema level so
   * roles authored before a library entry was canonicalised continue to load.
   */
  trait: z.string().min(1).max(80),
  /**
   * Free-text descriptors qualifying *how* the trait should manifest in this
   * role's voice (e.g. "calls out tradeoffs upfront"). Optional — a trait
   * with no qualifiers renders against the library's default description.
   */
  qualifiers: z.array(z.string().min(1).max(280)).max(8).default([]),
});

export const SeedInputSchema = z.object({
  organisation: OrganisationSchema,
  role_definition: RoleDefinitionSchema,
  identity: z
    .object({
      email: z.string().max(120).optional(),
      location: z.string().max(120).optional(),
      reports_to: z.string().max(120).optional(),
    })
    .default({}),
  voice_traits: z.array(VoiceTraitSchema).min(1).max(8),
  capabilities: z.array(z.string().min(1).max(280)).max(10).default([]),
  inhibitions: z.array(z.string().min(1).max(280)).max(10).default([]),
  initial_verbs: z.array(SeedVerbSchema).max(5).default([]),
  // Optional MCP capability names selected during tool selection. The
  // seeder filters the framework's `template/lib/tools.yaml` catalog to the
  // always-available built-ins plus these names, and writes the result to
  // the role's `lib/tools.yaml`. Empty array seeds a tools file containing
  // only the built-ins.
  tools: z.array(z.string().min(1).max(120)).max(40).default([]),
});

export type SeedInput = z.infer<typeof SeedInputSchema>;
export type SeedVerb = z.infer<typeof SeedVerbSchema>;
export type Organisation = z.infer<typeof OrganisationSchema>;
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;
export type VoiceTrait = z.infer<typeof VoiceTraitSchema>;

export interface SeedOptions {
  /**
   * Override the bundled template path. By default the package resolves a
   * `template/` directory either bundled alongside the package or at the
   * monorepo root — see `resolveTemplatePath()`.
   */
  templatePath?: string;
  /**
   * If true, the seeder will overwrite existing files at the target. When
   * false (default) it refuses if any of the files it would write already
   * exist with conflicting content.
   */
  overwrite?: boolean;
  /**
   * If true, no files are written. The returned `filesWritten` lists what
   * the seeder *would* write; `filesSkipped` is empty.
   */
  dryRun?: boolean;
}

export interface SeedResult {
  /** Absolute path that was seeded into. */
  targetPath: string;
  /** Paths (relative to targetPath) that were written. */
  filesWritten: string[];
  /** Paths the seeder declined to write because they already existed. */
  filesSkipped: string[];
}

/** Typed error class so callers can distinguish seed failures from generic Errors. */
export class SeedError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'TARGET_CONFLICT'
      | 'TEMPLATE_MISSING'
      | 'INVALID_INPUT'
      | 'WRITE_FAILED' = 'WRITE_FAILED',
  ) {
    super(message);
    this.name = 'SeedError';
  }
}
