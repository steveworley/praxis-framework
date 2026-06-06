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

/**
 * Recursively look for remote data references. A node is remote when it carries
 * a `data` property whose value is an object with a `url` key, or an array any
 * of whose elements is an object with a `url` key. May throw (e.g. stack
 * overflow on a pathologically deep spec); callers must guard.
 */
function hasRemoteData(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(hasRemoteData);
  if (node && typeof node === 'object') {
    const obj = node as Record<string, unknown>;
    const data = obj['data'];
    if (Array.isArray(data)) {
      const hasUrlElement = data.some(
        (el) => el !== null && typeof el === 'object' && 'url' in (el as Record<string, unknown>),
      );
      if (hasUrlElement) return true;
    } else if (data && typeof data === 'object' && 'url' in (data as Record<string, unknown>)) {
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
  let remote: boolean;
  try {
    remote = hasRemoteData(parsed);
  } catch {
    return { ok: false, error: 'Chart spec could not be validated.' };
  }
  if (remote) {
    return {
      ok: false,
      error: 'Chart spec may not load data from a remote url; use inline data.values.',
    };
  }
  return { ok: true, spec: parsed as Record<string, unknown> };
}
