import { isMcpAllowed } from './autonomy-gate.js';
import { getMcpCatalog } from './mcp-catalog.js';
import type { ToolResult } from './tools.js';

/**
 * Single transport + autonomy + activity-emit point for MCP tool dispatch.
 *
 * Flow:
 *   1. Resolve the server in the catalog. Refuse if unknown or not `connected`.
 *   2. Consult `isMcpAllowed(roleHome, serverName)`. Refuse on deny / missing.
 *   3. POST to `<serverUrl>/tools/call` with `{name, arguments}`. 30-second
 *      timeout — MCP servers can do slow IO (Slack search, file scans).
 *   4. Translate HTTP / network / shape errors to `ToolFailure` with a clear
 *      message naming the server.
 *   5. On success return a `ToolSuccess` with `summary: <server>__<method>`
 *      and the MCP response as `data`. The dispatcher's auto-instrumentation
 *      (in `executeTool`) handles the activity emission — `headlineFor`
 *      formats the `mcp: <server>.<method>` headline on the way out.
 */

const CALL_TIMEOUT_MS = 30_000;

export async function executeMcpCall(
  roleHome: string,
  serverName: string,
  methodName: string,
  args: unknown,
): Promise<ToolResult> {
  const catalog = await getMcpCatalog();
  const server = catalog.servers.find((s) => s.name === serverName);
  if (!server) {
    return failure(
      `MCP server '${serverName}' is not in PRAXIS_MCPS. Add it to docker-compose.yml and restart.`,
    );
  }
  if (server.status !== 'connected') {
    const detail = server.errorMessage ?? `status: ${server.status}`;
    return failure(
      `MCP server '${serverName}' is ${server.status} — ${detail}`,
    );
  }

  const gate = await isMcpAllowed(roleHome, serverName);
  if (!gate.allowed) return failure(gate.reason);

  const url = joinUrl(server.url, 'tools/call');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: methodName, arguments: args ?? {} }),
      signal: controller.signal,
    });
  } catch (error: unknown) {
    return failure(
      `MCP call ${serverName}.${methodName} failed: ${transportError(error)}`,
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return failure(
      `MCP server '${serverName}' returned HTTP ${response.status} for ${methodName}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error: unknown) {
    return failure(
      `MCP server '${serverName}' returned non-JSON for ${methodName}: ${errorMessage(error)}`,
    );
  }

  // MCP protocol: a tool error is signalled with `isError: true` in the
  // response body. Translate to a ToolFailure so the model sees it as a
  // structured refusal rather than a success-with-error-payload.
  if (typeof body === 'object' && body !== null) {
    const obj = body as Record<string, unknown>;
    if (obj['isError'] === true) {
      const message = mcpErrorMessage(obj);
      return failure(
        `MCP call ${serverName}.${methodName} errored: ${message}`,
      );
    }
  }

  const toolName = `${serverName}__${methodName}`;
  return {
    ok: true,
    summary: toolName,
    data: {
      mcp_server: serverName,
      mcp_method: methodName,
      response: body,
    },
  };
}

function joinUrl(base: string, suffix: string): string {
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/${suffix}`;
}

function transportError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return `timed out after ${CALL_TIMEOUT_MS}ms`;
    }
    return error.message;
  }
  return String(error);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mcpErrorMessage(body: Record<string, unknown>): string {
  // MCP spec: error responses commonly carry a `content` array of text blocks.
  // We extract the first text-like block; fall back to the raw shape.
  const content = body['content'];
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
  return JSON.stringify(body);
}

function failure(reason: string): ToolResult {
  return { ok: false, error: reason };
}
