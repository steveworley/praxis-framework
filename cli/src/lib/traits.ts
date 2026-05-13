/**
 * Re-export the canonical trait library from `@praxis-framework/seed`. Both the CLI's
 * voice flow (multi-select cloud) and the seeder (persona rendering) need
 * the same authored list, and the seed package owns the source of truth so
 * no copy can drift.
 *
 * A planned follow-up replaces the inline list in the seed package with a
 * loader that reads `template/lib/traits.yaml`, mirroring the way
 * `template/lib/tools.yaml` is loaded today. When that lands, this re-export
 * stays in place and the CLI's import path doesn't change.
 */

export { TRAIT_LIBRARY, findTrait } from '@praxis-framework/seed';
export type { TraitEntry } from '@praxis-framework/seed';
