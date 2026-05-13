/**
 * @praxis-framework/seed — shared role-seeding logic.
 *
 * The dashboard's setup wizard and the CLI's `praxis init` both call
 * `seedRole(input, targetPath, options?)` to materialise a populated
 * praxis role from the framework template. The function performs only
 * file IO; callers layer their own concerns (git commits, approval flows,
 * UI feedback) on top.
 */

export { seedRole, injectPersona, injectClaudeDescription, injectVerbsTable } from './seed.js';
export { resolveTemplatePath } from './template.js';
export { TRAIT_LIBRARY, findTrait } from './traits.js';
export type { TraitEntry } from './traits.js';
export {
  SeedVerbSchema,
  SeedInputSchema,
  OrganisationSchema,
  RoleDefinitionSchema,
  VoiceTraitSchema,
  SeedError,
} from './types.js';
export type {
  SeedVerb,
  SeedInput,
  SeedOptions,
  SeedResult,
  Organisation,
  RoleDefinition,
  VoiceTrait,
} from './types.js';
