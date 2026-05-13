import { SeedInputSchema, type SeedInput } from '@praxis-framework/seed';

import type { Form } from '../state/form.js';

/**
 * Adapt the CLI's permissive `Form` (every field optional / partial) into
 * the strict `SeedInput` the seed package validates against. By the time
 * the operator reaches the review step the wizard has walked them through
 * every required field, so this is a tightening conversion rather than a
 * remap.
 *
 * Returns either `{ ok: true; input }` or `{ ok: false; issues }` so the
 * review flow can surface validation problems inline rather than letting
 * the seed throw mid-write.
 */
export type AdaptResult =
  | { ok: true; input: SeedInput }
  | { ok: false; issues: { path: string; message: string }[] };

export function adaptFormToSeedInput(form: Form): AdaptResult {
  // Parse via the package schema directly. The CLI's Form already mirrors
  // the SeedInput shape one-to-one (modulo the `path` and partial wrapping)
  // so we can hand the relevant slice over and let zod do the strict
  // validation in one place.
  const candidate = {
    organisation: form.organisation,
    role_definition: form.role_definition,
    voice_traits: form.voice_traits,
    capabilities: form.capabilities,
    inhibitions: form.inhibitions,
    initial_verbs: form.initial_verbs,
    tools: form.tools,
  };

  const parsed = SeedInputSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.') || '<root>',
        message: i.message,
      })),
    };
  }
  return { ok: true, input: parsed.data };
}
