/**
 * Curated trait library for the voice & personality flow. Each entry pairs a
 * canonical lowercase token (the value stored on disk and selected by the
 * operator) with a one-line description used as the default rendering when
 * the operator hasn't supplied any qualifiers.
 *
 * This list lives in `@praxis-framework/seed` because two callers need it:
 *   - the CLI's voice flow shows it to the operator as a multi-select cloud,
 *   - the seeder injects descriptions into `persona.md` when a trait
 *     has no qualifiers attached.
 *
 * v1 keeps the library inline. A planned follow-up moves the authored copy
 * to `template/lib/traits.yaml` (mirroring `tools.yaml`) so operators can
 * extend it; the consumers will then load it through a catalog reader rather
 * than importing this constant.
 */

export interface TraitEntry {
  /** Short canonical token, lowercase. Stored on disk. */
  name: string;
  /** One-line description shown alongside the trait when picking. */
  description: string;
}

export const TRAIT_LIBRARY: readonly TraitEntry[] = [
  { name: 'direct', description: 'short sentences, no hedging, names the next step' },
  { name: 'warm', description: 'reads as a person, not a process — softens hard messages' },
  { name: 'curious', description: 'asks questions before pitching; pulls on threads' },
  { name: 'analytical', description: 'reasons from evidence; shows the working' },
  { name: 'patient', description: 'lets the other side finish; never rushes a decision' },
  { name: 'decisive', description: 'commits to a recommendation rather than presenting options' },
  { name: 'playful', description: 'comfortable with humour; not afraid of a light touch' },
  { name: 'formal', description: 'polished register, full sentences, no contractions in writing' },
  { name: 'casual', description: 'plain speech; uses contractions and idioms naturally' },
  { name: 'methodical', description: 'takes the next obvious step; checks the work before moving on' },
  { name: 'empathetic', description: "leads with the other side's position before stating their own" },
  { name: 'skeptical', description: 'pressure-tests claims; assumes the simple story is incomplete' },
  { name: 'pragmatic', description: 'optimises for what works in this context, not the textbook answer' },
  { name: 'concise', description: 'cuts hedge phrases; one idea per sentence' },
  { name: 'thorough', description: 'covers edge cases; trades brevity for completeness when stakes warrant' },
  { name: 'calm', description: "steady tone under pressure; doesn't escalate language with stress" },
  { name: 'observant', description: 'names what changed; references prior threads explicitly' },
  { name: 'bold', description: 'willing to disagree on the record; states a position even when unpopular' },
  { name: 'attentive', description: 'tracks who said what and when; quotes back to confirm understanding' },
  { name: 'resourceful', description: 'finds a way around blockers without waiting to be told how' },
];

/** Look up a trait by its canonical name. Returns `undefined` for unknowns. */
export function findTrait(name: string): TraitEntry | undefined {
  return TRAIT_LIBRARY.find((t) => t.name === name);
}
