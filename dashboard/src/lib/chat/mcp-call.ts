import { isMcpAllowed } from './autonomy-gate.js';
import { callMcpTool } from './mcp-catalog.js';
import type { ToolResult } from './tools.js';

/**
 * Autonomy + error-translation point for MCP tool dispatch.
 *
 * The MCP transport itself (the stateful per-server `Client` session) is owned
 * by `mcp-catalog.ts`; this module keeps only the policy + translation layer:
 *
 *   1. Consult `isMcpAllowed(roleHome, serverName)`. Refuse on deny / missing.
 *   2. Delegate to the catalog-owned `callMcpTool` — which reuses the warm
 *      per-server MCP client and never throws.
 *   3. Translate the outcome:
 *        - `unavailable`  → `ToolFailure` (unknown / unreachable / transport
 *          drop), message names the server.
 *        - `toolError`    → `ToolFailure` (MCP `isError: true`), so the model
 *          sees a structured refusal rather than a success-with-error payload.
 *        - `success`      → `ToolSuccess` with `summary: <server>__<method>`
 *          and the MCP response as `data`. The dispatcher's
 *          auto-instrumentation handles the activity emission.
 *
 * Note: the server-known and server-connected checks live inside the catalog's
 * `callMcpTool` (it owns the session state). We run the autonomy gate first so
 * a denied server is refused before we touch the transport at all.
 */

export async function executeMcpCall(
  roleHome: string,
  serverName: string,
  methodName: string,
  args: unknown,
): Promise<ToolResult> {
  const gate = await isMcpAllowed(roleHome, serverName);
  if (!gate.allowed) return failure(gate.reason);

  const outcome = await callMcpTool(serverName, methodName, args);
  if (outcome.kind === 'unavailable') {
    return failure(outcome.reason);
  }
  if (outcome.kind === 'toolError') {
    return failure(
      `MCP call ${serverName}.${methodName} errored: ${outcome.message}`,
    );
  }

  const toolName = `${serverName}__${methodName}`;
  return {
    ok: true,
    summary: toolName,
    data: {
      mcp_server: serverName,
      mcp_method: methodName,
      response: outcome.response,
    },
  };
}

function failure(reason: string): ToolResult {
  return { ok: false, error: reason };
}
