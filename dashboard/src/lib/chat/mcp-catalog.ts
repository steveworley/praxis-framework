import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

/**
 * MCP catalog — discovers MCP servers via the `PRAXIS_MCPS` environment
 * variable, connects to each over the standard MCP protocol (JSON-RPC over
 * Streamable HTTP) using the official `@modelcontextprotocol/sdk` client,
 * fetches each server's tool catalog at startup, and exposes both the
 * per-server status (for the warning banner / `/capabilities` screen) and the
 * flattened per-method tool list (for `getChatTools`).
 *
 * `PRAXIS_MCPS` format: `name=url[,name=url...]`, e.g.
 *   `quant=http://mcp-quant:8080/mcp,slack=http://mcp-slack:8080/mcp`
 * where the url is the server's Streamable HTTP endpoint.
 *
 * Each server is treated as a sibling service in the same docker-compose
 * stack as the dashboard. We open one stateful MCP session per server
 * (`Client` + `StreamableHTTPClientTransport`), call `listTools()` once to
 * build the catalog, and reuse that same connected client for every
 * `callTool` — MCP sessions are stateful, so we connect once and keep the
 * client warm. The discovered `inputSchema` is passed through verbatim to
 * Anthropic's `input_schema` field — no Zod conversion. Verbatim pass-through
 * means a misbehaving MCP server's schema lands directly in the model's tool
 * definition; we lean on Anthropic's validator to catch shape errors.
 *
 * Lazy-loading + per-server retry debounce: a server that's down at boot
 * doesn't break the dashboard. The catalog is re-connected on demand; if a
 * server's status is `unreachable | error` AND its last attempt was more than
 * `RETRY_DEBOUNCE_MS` ago, the next `getMcpCatalog()` call retries that
 * server. Otherwise the cached (failed) state is returned. Concurrent
 * `getMcpCatalog()` calls are deduplicated via per-server in-flight Promises.
 *
 * On transport close or error after a successful connect, the cached client
 * is dropped and the server's status is flipped to `unreachable` so the next
 * `getMcpCatalog()` (past the debounce window) re-establishes the session.
 */

const RETRY_DEBOUNCE_MS = 60_000;
const CONNECT_TIMEOUT_MS = 5_000;
const CALL_TIMEOUT_MS = 30_000;

export type McpServerStatusKind = 'connected' | 'unreachable' | 'error';

export interface McpServerStatus {
  /** Server name from `PRAXIS_MCPS` (the prefix used in tool names). */
  name: string;
  /** Streamable HTTP endpoint the dashboard connects the MCP client to. */
  url: string;
  /** Liveness: `connected` once we've completed an MCP `listTools`. */
  status: McpServerStatusKind;
  /** Count of methods discovered on the server (0 when unreachable). */
  toolCount: number;
  /** Operator-visible error string for `unreachable` / `error` states. */
  errorMessage?: string;
  /** ISO timestamp of the last connect/list attempt (success or failure). */
  lastFetchedAt?: string;
}

export interface McpTool {
  /** Server name (prefix in `<server>__<method>`). */
  serverName: string;
  /** Method name on the MCP server (suffix in `<server>__<method>`). */
  methodName: string;
  /** Synthesised Anthropic tool name: `<server>__<method>`. */
  toolName: string;
  /** Description sourced from the MCP server's `listTools` response. */
  description: string;
  /** JSON Schema passed through verbatim to Anthropic's `input_schema`. */
  inputSchema: unknown;
}

export interface McpCatalog {
  servers: McpServerStatus[];
  tools: McpTool[];
}

/**
 * Outcome of a catalog-owned `callTool`. `unavailable` separates "the server
 * isn't connected / known" from "the connected server's tool errored"
 * (`toolError`) and from a clean `success`. `mcp-call.ts` maps each variant
 * to the right `ToolResult` shape, keeping all transport ownership here.
 */
export type McpCallOutcome =
  | { kind: 'success'; response: unknown }
  | { kind: 'toolError'; message: string }
  | { kind: 'unavailable'; reason: string };

interface ServerEntry {
  name: string;
  url: string;
}

interface CachedServerState {
  status: McpServerStatus;
  tools: McpTool[];
  /** Live MCP client, present only while `status === 'connected'`. */
  client?: Client;
}

/**
 * Builds the MCP transport for a server. Defaults to the real Streamable HTTP
 * transport; tests swap in an `InMemoryTransport` via `_setTransportFactory`
 * so they can drive an in-process MCP server without real sockets.
 */
type TransportFactory = (entry: ServerEntry) => Transport;

const defaultTransportFactory: TransportFactory = (entry) =>
  new StreamableHTTPClientTransport(new URL(entry.url), {
    // Phase-2 remote-auth seam: optional per-server headers read from a
    // `PRAXIS_MCP_HEADERS_<name>` env convention (JSON object of header name →
    // value). Inert/no-op when unset — local docker-compose siblings need no
    // auth today; this is where a bearer token / API key would be attached
    // once we talk to remote MCP servers.
    ...buildTransportInit(entry.name),
  });

// Module-level caches. A test seam (`_resetMcpCatalog`) clears them so each
// test starts from a clean slate.
const serverCache: Map<string, CachedServerState> = new Map();
const inflight: Map<string, Promise<CachedServerState>> = new Map();
let envSnapshot: string | undefined;
let parsedEntries: ServerEntry[] = [];
let transportFactory: TransportFactory = defaultTransportFactory;

/**
 * Public entry point — returns the current catalog, refreshing stale failed
 * entries on the way through. Never throws; failed servers surface as
 * `unreachable | error` entries with `toolCount: 0`.
 */
export async function getMcpCatalog(): Promise<McpCatalog> {
  refreshEnvSnapshot();

  await Promise.all(parsedEntries.map((entry) => connectServerIfNeeded(entry)));

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
 * Call a method on a connected MCP server using the catalog-owned client.
 * The catalog owns the stateful MCP session, so dispatch goes through here
 * rather than each caller opening its own connection. Refreshes the catalog
 * first so a never-connected server gets one connect attempt. Never throws —
 * transport failures and unknown/unreachable servers surface as `unavailable`.
 */
export async function callMcpTool(
  serverName: string,
  methodName: string,
  args: unknown,
): Promise<McpCallOutcome> {
  const catalog = await getMcpCatalog();
  const server = catalog.servers.find((s) => s.name === serverName);
  if (!server) {
    return {
      kind: 'unavailable',
      reason: `MCP server '${serverName}' is not in PRAXIS_MCPS. Add it to docker-compose.yml and restart.`,
    };
  }
  if (server.status !== 'connected') {
    const detail = server.errorMessage ?? `status: ${server.status}`;
    return {
      kind: 'unavailable',
      reason: `MCP server '${serverName}' is ${server.status} — ${detail}`,
    };
  }

  const cached = serverCache.get(serverName);
  const client = cached?.client;
  if (!client) {
    return {
      kind: 'unavailable',
      reason: `MCP server '${serverName}' is connected but has no live client — retry shortly.`,
    };
  }

  let result: Awaited<ReturnType<Client['callTool']>>;
  try {
    result = await client.callTool(
      { name: methodName, arguments: toArguments(args) },
      undefined,
      { timeout: CALL_TIMEOUT_MS },
    );
  } catch (error: unknown) {
    // A transport-level failure means the session is dead — drop the cached
    // client so the next catalog refresh (past the debounce window) reconnects.
    markUnreachable(serverName, errorMessage(error));
    return {
      kind: 'unavailable',
      reason: `MCP call ${serverName}.${methodName} failed: ${errorMessage(error)}`,
    };
  }

  // MCP protocol: a tool error is signalled with `isError: true` on the
  // result. Surface it as a `toolError` so `mcp-call.ts` can translate it into
  // a structured ToolFailure rather than a success-with-error-payload.
  if (result.isError === true) {
    return { kind: 'toolError', message: mcpErrorMessage(result) };
  }

  return { kind: 'success', response: result };
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
  // restart-free env change doesn't leak stale state (closing any live
  // client on the way out).
  const live = new Set(parsedEntries.map((e) => e.name));
  for (const [name, state] of serverCache) {
    if (!live.has(name)) {
      closeClient(state.client);
      serverCache.delete(name);
    }
  }
}

async function connectServerIfNeeded(entry: ServerEntry): Promise<CachedServerState> {
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
  const promise = connectServer(entry).finally(() => {
    inflight.delete(entry.name);
  });
  inflight.set(entry.name, promise);
  return promise;
}

async function connectServer(entry: ServerEntry): Promise<CachedServerState> {
  const lastFetchedAt = new Date().toISOString();
  let client: Client | undefined;
  try {
    const transport = transportFactory(entry);
    client = new Client({ name: 'praxis-dashboard', version: '0.0.0' });
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });

    const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
    const tools = mapTools(entry.name, listed.tools);

    // Reconnect-on-drop: if the session dies later, flip status so the next
    // refresh (past the debounce) re-establishes it.
    client.onclose = () => {
      markUnreachable(entry.name, 'MCP session closed');
    };
    client.onerror = (error: Error) => {
      markUnreachable(entry.name, error.message);
    };

    const state: CachedServerState = {
      status: {
        name: entry.name,
        url: entry.url,
        status: 'connected',
        toolCount: tools.length,
        lastFetchedAt,
      },
      tools,
      client,
    };
    serverCache.set(entry.name, state);
    return state;
  } catch (error: unknown) {
    closeClient(client);
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

/**
 * Build the transport's `requestInit` from the optional per-server header
 * seam. Returns an empty options object when no headers are configured so the
 * transport runs with its defaults. The env var holds a JSON object of header
 * name → value (e.g. `PRAXIS_MCP_HEADERS_quant={"Authorization":"Bearer x"}`);
 * malformed JSON is ignored rather than crashing the catalog.
 */
function buildTransportInit(serverName: string): { requestInit?: RequestInit } {
  const raw = process.env[`PRAXIS_MCP_HEADERS_${serverName}`];
  if (!raw || raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null) return {};
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') headers[key] = value;
  }
  if (Object.keys(headers).length === 0) return {};
  return { requestInit: { headers } };
}

function mapTools(
  serverName: string,
  rawTools: Awaited<ReturnType<Client['listTools']>>['tools'],
): McpTool[] {
  const out: McpTool[] = [];
  for (const item of rawTools) {
    const methodName = item.name;
    if (typeof methodName !== 'string' || methodName.length === 0) continue;
    const toolName = `${serverName}__${methodName}`;
    // Anthropic's tool-name regex is `^[a-zA-Z0-9_-]{1,128}$`.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(toolName)) continue;
    const description = typeof item.description === 'string' ? item.description : '';
    // Verbatim pass-through — the MCP server's JSON Schema lands directly in
    // the Anthropic tool definition. Fall back to an empty object schema only
    // when the server omits one entirely.
    const inputSchema = item.inputSchema ?? { type: 'object', properties: {} };
    out.push({ serverName, methodName, toolName, description, inputSchema });
  }
  return out;
}

/**
 * Flip a server to `unreachable` and tear down its cached client. Called from
 * the transport `onclose` / `onerror` hooks and on a failed `callTool` so a
 * dropped session is re-established on the next refresh past the debounce.
 */
function markUnreachable(serverName: string, message: string): void {
  const cached = serverCache.get(serverName);
  if (!cached) return;
  closeClient(cached.client);
  serverCache.set(serverName, {
    status: {
      name: cached.status.name,
      url: cached.status.url,
      status: 'unreachable',
      toolCount: 0,
      errorMessage: message,
      lastFetchedAt: new Date().toISOString(),
    },
    tools: [],
  });
}

function closeClient(client: Client | undefined): void {
  if (!client) return;
  // Detach hooks before closing so our own teardown doesn't re-enter
  // `markUnreachable` via `onclose`.
  client.onclose = undefined;
  client.onerror = undefined;
  void client.close().catch(() => {
    // Best-effort — a client we're discarding can't surface a useful error.
  });
}

function toArguments(args: unknown): Record<string, unknown> {
  if (typeof args === 'object' && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  return {};
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function mcpErrorMessage(result: Record<string, unknown>): string {
  // MCP tool errors carry a `content` array of blocks; extract the first text
  // block and fall back to the raw shape.
  const content = result['content'];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (typeof block === 'object' && block !== null) {
        const obj = block as Record<string, unknown>;
        if (typeof obj['text'] === 'string' && obj['text'].length > 0) {
          return obj['text'];
        }
      }
    }
  }
  return JSON.stringify(result);
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
  for (const state of serverCache.values()) {
    closeClient(state.client);
  }
  serverCache.clear();
  inflight.clear();
  envSnapshot = undefined;
  parsedEntries = [];
  transportFactory = defaultTransportFactory;
}

/**
 * Test seam — swap the transport factory so tests can wire an
 * `InMemoryTransport` to an in-process MCP server. Pass `null` to restore the
 * default Streamable HTTP transport. Never used in production code paths.
 */
export function _setTransportFactory(factory: TransportFactory | null): void {
  transportFactory = factory ?? defaultTransportFactory;
}

/** Test seam — direct read of the parsed env-var entries (post-refresh). */
export function _getParsedEntries(): ServerEntry[] {
  refreshEnvSnapshot();
  return parsedEntries.slice();
}
