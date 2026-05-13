/**
 * MCP catalog — discovers MCP servers via the `PRAXIS_MCPS` environment
 * variable, fetches each server's tool catalog at startup, and exposes both
 * the per-server status (for the warning banner / `/capabilities` screen) and
 * the flattened per-method tool list (for `getChatTools`).
 *
 * `PRAXIS_MCPS` format: `name=url[,name=url...]`, e.g.
 *   `slack=http://mcp-slack:8080,gmail=http://mcp-gmail:8080`
 *
 * Each server is treated as a sibling service in the same docker-compose
 * stack as the dashboard. We POST to `<url>/tools/list` per MCP spec
 * (`{ tools: [{ name, description, inputSchema }] }`) and pass the
 * `inputSchema` through verbatim to Anthropic's `input_schema` field — no
 * Zod conversion. Verbatim pass-through means a misbehaving MCP server's
 * schema lands directly in the model's tool definition; we lean on
 * Anthropic's validator to catch shape errors.
 *
 * Lazy-loading + per-server retry debounce: a server that's down at boot
 * doesn't break the dashboard. The catalog is re-fetched on demand; if a
 * server's status is `unreachable | error` AND its last attempt was more
 * than `RETRY_DEBOUNCE_MS` ago, the next `getMcpCatalog()` call retries that
 * server. Otherwise the cached (failed) state is returned. Concurrent
 * `getMcpCatalog()` calls are deduplicated via per-server in-flight Promises.
 */

const RETRY_DEBOUNCE_MS = 60_000;
const LIST_TIMEOUT_MS = 5_000;

export type McpServerStatusKind = 'connected' | 'unreachable' | 'error';

export interface McpServerStatus {
  /** Server name from `PRAXIS_MCPS` (the prefix used in tool names). */
  name: string;
  /** Base URL the dashboard fetches the catalog from. */
  url: string;
  /** Liveness: `connected` once we've seen a valid `tools/list` response. */
  status: McpServerStatusKind;
  /** Count of methods discovered on the server (0 when unreachable). */
  toolCount: number;
  /** Operator-visible error string for `unreachable` / `error` states. */
  errorMessage?: string;
  /** ISO timestamp of the last `tools/list` attempt (success or failure). */
  lastFetchedAt?: string;
}

export interface McpTool {
  /** Server name (prefix in `<server>__<method>`). */
  serverName: string;
  /** Method name on the MCP server (suffix in `<server>__<method>`). */
  methodName: string;
  /** Synthesised Anthropic tool name: `<server>__<method>`. */
  toolName: string;
  /** Description sourced from the MCP server's `tools/list` response. */
  description: string;
  /** JSON Schema passed through verbatim to Anthropic's `input_schema`. */
  inputSchema: unknown;
}

export interface McpCatalog {
  servers: McpServerStatus[];
  tools: McpTool[];
}

interface ServerEntry {
  name: string;
  url: string;
}

interface CachedServerState {
  status: McpServerStatus;
  tools: McpTool[];
}

// Module-level caches. A test seam (`_resetCatalog`) clears them so each test
// starts from a clean slate.
const serverCache: Map<string, CachedServerState> = new Map();
const inflight: Map<string, Promise<CachedServerState>> = new Map();
let envSnapshot: string | undefined;
let parsedEntries: ServerEntry[] = [];

/**
 * Public entry point — returns the current catalog, refreshing stale failed
 * entries on the way through. Never throws; failed servers surface as
 * `unreachable | error` entries with `toolCount: 0`.
 */
export async function getMcpCatalog(): Promise<McpCatalog> {
  refreshEnvSnapshot();

  await Promise.all(parsedEntries.map((entry) => fetchServerIfNeeded(entry)));

  const servers: McpServerStatus[] = [];
  const tools: McpTool[] = [];
  for (const entry of parsedEntries) {
    const cached = serverCache.get(entry.name);
    if (!cached) continue;
    servers.push(cached.status);
    if (cached.status.status === 'connected') {
      tools.push(...cached.tools);
    }
  }
  return { servers, tools };
}

/**
 * Parse `PRAXIS_MCPS` into a list of `{name, url}` entries. Exported for
 * tests. Malformed entries are dropped; duplicate names keep the first one
 * (the env-var snapshot is the source of truth, not the test fixture).
 */
export function parsePraxisMcps(raw: string | undefined): ServerEntry[] {
  if (!raw || raw.trim().length === 0) return [];
  const entries: ServerEntry[] = [];
  const seen = new Set<string>();
  for (const piece of raw.split(',')) {
    const trimmed = piece.trim();
    if (trimmed.length === 0) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const name = trimmed.slice(0, eq).trim();
    const url = trimmed.slice(eq + 1).trim();
    if (name.length === 0 || url.length === 0) continue;
    // Anthropic's tool-name regex is `^[a-zA-Z0-9_-]{1,128}$` — keep server
    // names within that alphabet (we still need `__` headroom for the join).
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    entries.push({ name, url });
  }
  return entries;
}

function refreshEnvSnapshot(): void {
  const current = process.env['PRAXIS_MCPS'];
  if (current === envSnapshot) return;
  envSnapshot = current;
  parsedEntries = parsePraxisMcps(current);
  // Drop cache entries whose servers were removed from PRAXIS_MCPS so a
  // restart-free env change doesn't leak stale state.
  const live = new Set(parsedEntries.map((e) => e.name));
  for (const name of serverCache.keys()) {
    if (!live.has(name)) serverCache.delete(name);
  }
}

async function fetchServerIfNeeded(entry: ServerEntry): Promise<CachedServerState> {
  const cached = serverCache.get(entry.name);
  if (cached) {
    if (cached.status.status === 'connected') return cached;
    // Failed states: retry only if past the debounce window.
    if (cached.status.lastFetchedAt) {
      const last = Date.parse(cached.status.lastFetchedAt);
      if (Number.isFinite(last) && Date.now() - last < RETRY_DEBOUNCE_MS) {
        return cached;
      }
    }
  }
  const pending = inflight.get(entry.name);
  if (pending) return pending;
  const promise = fetchServer(entry).finally(() => {
    inflight.delete(entry.name);
  });
  inflight.set(entry.name, promise);
  return promise;
}

async function fetchServer(entry: ServerEntry): Promise<CachedServerState> {
  const lastFetchedAt = new Date().toISOString();
  const url = joinUrl(entry.url, 'tools/list');
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const state: CachedServerState = {
        status: {
          name: entry.name,
          url: entry.url,
          status: 'error',
          toolCount: 0,
          errorMessage: `tools/list returned HTTP ${response.status}`,
          lastFetchedAt,
        },
        tools: [],
      };
      serverCache.set(entry.name, state);
      return state;
    }
    const body = (await response.json()) as unknown;
    const tools = extractTools(entry.name, body);
    const state: CachedServerState = {
      status: {
        name: entry.name,
        url: entry.url,
        status: 'connected',
        toolCount: tools.length,
        lastFetchedAt,
      },
      tools,
    };
    serverCache.set(entry.name, state);
    return state;
  } catch (error: unknown) {
    const state: CachedServerState = {
      status: {
        name: entry.name,
        url: entry.url,
        status: 'unreachable',
        toolCount: 0,
        errorMessage: errorMessage(error),
        lastFetchedAt,
      },
      tools: [],
    };
    serverCache.set(entry.name, state);
    return state;
  }
}

function extractTools(serverName: string, body: unknown): McpTool[] {
  if (typeof body !== 'object' || body === null) return [];
  const rawTools = (body as { tools?: unknown }).tools;
  if (!Array.isArray(rawTools)) return [];
  const out: McpTool[] = [];
  for (const item of rawTools) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const methodName = typeof obj['name'] === 'string' ? obj['name'] : '';
    if (methodName.length === 0) continue;
    const toolName = `${serverName}__${methodName}`;
    // Anthropic's tool-name regex is `^[a-zA-Z0-9_-]{1,128}$`.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(toolName)) continue;
    const description =
      typeof obj['description'] === 'string' ? obj['description'] : '';
    const inputSchema = obj['inputSchema'] ?? { type: 'object', properties: {} };
    out.push({
      serverName,
      methodName,
      toolName,
      description,
      inputSchema,
    });
  }
  return out;
}

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/${suffix}`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) {
    return e.name === 'AbortError'
      ? `tools/list timed out after ${LIST_TIMEOUT_MS}ms`
      : e.message;
  }
  return String(e);
}

/**
 * Compare the role's declared MCP capabilities (from `lib/tools.yaml` —
 * entries shaped `mcp:<name>`) against the configured `PRAXIS_MCPS` env var.
 * Returns the list of declared servers that are NOT configured in the
 * compose stack. The `/chat` warning banner surfaces these so an operator
 * who forgot to add a service to docker-compose.yml sees the gap.
 *
 * Lives here (not in `system-prompt.ts`) because the catalog is the
 * authoritative source of "which MCPs the dashboard knows about" — the
 * banner is asking "what did the role expect that I don't have?"
 */
export function findMissingMcpDeclarations(
  declaredCapabilities: readonly string[],
): string[] {
  refreshEnvSnapshot();
  const configured = new Set(parsedEntries.map((e) => e.name));
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const cap of declaredCapabilities) {
    if (typeof cap !== 'string') continue;
    if (!cap.startsWith('mcp:')) continue;
    const name = cap.slice('mcp:'.length).trim();
    if (name.length === 0) continue;
    if (configured.has(name)) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    missing.push(name);
  }
  return missing;
}

/** Test seam — clear all caches + force re-parse of `PRAXIS_MCPS`. */
export function _resetMcpCatalog(): void {
  serverCache.clear();
  inflight.clear();
  envSnapshot = undefined;
  parsedEntries = [];
}

/** Test seam — direct read of the parsed env-var entries (post-refresh). */
export function _getParsedEntries(): ServerEntry[] {
  refreshEnvSnapshot();
  return parsedEntries.slice();
}
