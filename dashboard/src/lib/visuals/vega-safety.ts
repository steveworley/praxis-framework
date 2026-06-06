/**
 * Vega-Lite specs are author-supplied JSON. We render them in the browser, so
 * before handing a spec to vega-embed we (a) confirm it is valid JSON and
 * (b) refuse any spec that would make the browser fetch a remote resource via
 * a `data.url`. Charts must be self-contained (inline `data.values`). This
 * keeps a chart from becoming an SSRF / data-exfil vector.
 */
export type SafeSpecResult =
  | { ok: true; spec: Record<string, unknown> }
  | { ok: false; error: string };

/** Recursively look for any object key named `url` under a `data` object. */
function hasRemoteData(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRemoteData);
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const data = obj['data'];
    if (data && typeof data === 'object' && 'url' in (data as Record<string, unknown>)) {
      return true;
    }
    return Object.values(obj).some(hasRemoteData);
  }
  return false;
}

export function parseSafeVegaSpec(source: string): SafeSpecResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    return { ok: false, error: 'Chart spec is not valid JSON.' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'Chart spec must be a JSON object.' };
  }
  if (hasRemoteData(parsed)) {
    return {
      ok: false,
      error: 'Chart spec may not load data from a remote url; use inline data.values.',
    };
  }
  return { ok: true, spec: parsed as Record<string, unknown> };
}
