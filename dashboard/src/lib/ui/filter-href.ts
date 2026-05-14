/**
 * Pure helper for building chip hrefs that preserve unrelated query params.
 * The journal-shaped list surfaces (`/notebook`, `/escalations`, `/output`,
 * `/activity`) all use the same pattern: changing one filter axis updates
 * its query key in place and leaves every other param alone. Defaults can
 * be elided from the URL so the canonical "no filter applied" link is a
 * bare path.
 *
 * Pulled into its own module so the per-page filter wiring is a one-line
 * call and the omit-default-keys logic is unit-testable independently of
 * Astro.
 */

export interface BuildChipHrefOptions {
  /** Pathname for the link (e.g. `/escalations`). Query string is rebuilt. */
  pathname: string;
  /** Current search params (only the keys this filter group cares about). */
  current: Record<string, string>;
  /** The filter group key being changed (e.g. `status`). */
  group: string;
  /** The value the chip should set the group to. */
  value: string;
  /**
   * Default value per filter group. When `current[group] === defaults[group]`
   * the key is omitted from the URL so the canonical "show everything" link
   * stays bare.
   */
  defaults: Record<string, string>;
}

export function buildChipHref(opts: BuildChipHrefOptions): string {
  const next: Record<string, string> = { ...opts.current, [opts.group]: opts.value };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) {
    if (v === undefined || v === '') continue;
    if (opts.defaults[k] !== undefined && v === opts.defaults[k]) continue;
    params.set(k, v);
  }
  const q = params.toString();
  return q ? `${opts.pathname}?${q}` : opts.pathname;
}
