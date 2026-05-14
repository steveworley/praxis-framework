/**
 * Build the warm time-and-state-aware greeting that headlines `/chat`.
 *
 * The greeting is deterministic and computed once per page-load — no Anthropic
 * call. Templates are picked by:
 *
 *   - `localHour` (0-23) bucketed into morning / afternoon / evening / night.
 *   - whether the role has open escalations waiting on the operator.
 *
 * Variants for the operator name:
 *   - `PRAXIS_OPERATOR_NAME` env var → use verbatim ("Steve", "Mira").
 *   - unset → fall back to `"you"`. Never hardcode a name in this module.
 *
 * The returned shape ships the pieces the hero needs to render: a pixel-font
 * `who · time-bucket · status` line and a paragraph-shaped greeting body with
 * an inline call-to-action anchor when escalations are open.
 */

export interface GreetingInput {
  /** Persona display name (e.g. "Sam"). Used in the WHO label and CTA wording. */
  personaShort: string;
  /** Local hour, 0-23. */
  localHour: number;
  /** Count of open escalations across all kinds. */
  escalationOpenCount: number;
  /** Operator name override; resolved by the page from `PRAXIS_OPERATOR_NAME`. */
  operatorName?: string;
}

export type TimeBucket = 'morning' | 'afternoon' | 'evening' | 'night';

export interface Greeting {
  /** Pixel-font preamble. e.g. `SAM · MORNING · 2 OPEN`. */
  who: string;
  /** Time bucket — drives the salutation. */
  bucket: TimeBucket;
  /** First sentence of the greeting body — the salutation. */
  salutation: string;
  /** Remaining body sentence after the salutation. */
  body: string;
  /**
   * When > 0, the greeting body includes a CTA the page renders as an
   * underlined anchor to `/escalations?status=open`. Empty string when there
   * are no open escalations.
   */
  ctaText: string;
  /** True when the body is the "nothing waiting" empty-state variant. */
  empty: boolean;
}

export function bucketFromHour(hour: number): TimeBucket {
  if (hour < 12) return 'morning';
  if (hour < 17) return 'afternoon';
  if (hour < 21) return 'evening';
  return 'night';
}

function salutationFor(bucket: TimeBucket): string {
  switch (bucket) {
    case 'morning':
      return 'Morning';
    case 'afternoon':
      return 'Afternoon';
    case 'evening':
      return 'Evening';
    case 'night':
      return 'Working late?';
  }
}

export function buildGreeting(input: GreetingInput): Greeting {
  const bucket = bucketFromHour(input.localHour);
  const salutation = salutationFor(bucket);
  const operator = (input.operatorName ?? '').trim() || 'you';
  // "Morning, Steve." vs "Morning."
  const salHead = operator === 'you' ? `${salutation}.` : `${salutation}, ${operator}.`;
  const who = composeWho(input.personaShort, bucket, input.escalationOpenCount);

  if (input.escalationOpenCount === 0) {
    return {
      who,
      bucket,
      salutation: salHead,
      body: 'Nothing waiting — what should we look at today?',
      ctaText: '',
      empty: true,
    };
  }

  const n = input.escalationOpenCount;
  const noun = n === 1 ? 'escalation' : 'escalations';
  const verb = n === 1 ? 'is' : 'are';
  const them = n === 1 ? 'it' : 'them';
  const ctaText = `triage ${them}`;
  // Sentence shape:
  //  "Two escalations from yesterday are still waiting on you — want to
  //   triage them, or pick up where we left off?"
  // The page renders `ctaText` as an underlined anchor; the surrounding
  // wording is supplied as `body` with a `{cta}` token the page replaces.
  const body = `${spelledCount(n)} ${noun} ${verb} still waiting on you — want to {cta}, or pick up where we left off?`;
  return {
    who,
    bucket,
    salutation: salHead,
    body,
    ctaText,
    empty: false,
  };
}

function composeWho(personaShort: string, bucket: TimeBucket, openCount: number): string {
  const head = personaShort.trim().toUpperCase() || 'ROLE';
  const middle = bucket.toUpperCase();
  if (openCount <= 0) {
    return `${head} · ${middle} · CLEAR`;
  }
  return `${head} · ${middle} · ${openCount} OPEN`;
}

/**
 * Spell small counts ("one" through "nine") and fall back to numerals for
 * larger values. Keeps the greeting reading like prose — "Two escalations…"
 * not "2 escalations…".
 */
function spelledCount(n: number): string {
  const words = [
    'Zero',
    'One',
    'Two',
    'Three',
    'Four',
    'Five',
    'Six',
    'Seven',
    'Eight',
    'Nine',
  ];
  if (n >= 0 && n < words.length) return words[n] ?? String(n);
  return String(n);
}
