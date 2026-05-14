import fs from 'node:fs/promises';
import path from 'node:path';

import { findMissingMcpDeclarations, getMcpCatalog } from '@/lib/chat/mcp-catalog.js';
import { parseToolsYaml } from '@/lib/chat/system-prompt.js';

/**
 * MCP configuration drift report — surfaces config-vs-runtime mismatches
 * between the role's declared MCP capabilities (`lib/tools.yaml`) and the
 * dashboard's configured `PRAXIS_MCPS` env var, plus any servers that are
 * configured but currently unreachable.
 *
 * Lives in `lib/health/` (not `lib/chat/`) because this is a health concern —
 * it tells the operator the runtime stack doesn't match the role's declared
 * needs. The chat surface no longer carries this banner; the panel is
 * rendered on `/health` next to the other observability sections.
 */

export interface UnreachableServer {
  /** Server name from `PRAXIS_MCPS`. */
  name: string;
  /** `unreachable | error` — the catalog's liveness state. */
  status: string;
  /** Operator-visible error string from the failed `tools/list` attempt. */
  message?: string;
}

export interface McpWarnings {
  /** Servers declared as `mcp:<name>` in lib/tools.yaml but missing from PRAXIS_MCPS. */
  missingDeclared: string[];
  /** Servers configured in PRAXIS_MCPS but currently unreachable / errored. */
  unreachable: UnreachableServer[];
}

/**
 * Assemble the MCP warning report for a given role home. Reads
 * `<home>/lib/tools.yaml` to discover declared MCP capabilities, asks the
 * MCP catalog which configured servers are unreachable, and returns both
 * lists. Never throws — a missing `tools.yaml` is treated as "no declared
 * capabilities" and produces an empty `missingDeclared`.
 */
export async function assembleMcpWarnings(home: string): Promise<McpWarnings> {
  let declaredCapabilities: string[] = [];
  try {
    const toolsYaml = await fs.readFile(
      path.join(home, 'lib', 'tools.yaml'),
      'utf-8',
    );
    declaredCapabilities = parseToolsYaml(toolsYaml).map((t) => t.name);
  } catch {
    // No tools.yaml — no declared capabilities to compare against.
  }
  const missingDeclared = findMissingMcpDeclarations(declaredCapabilities);
  const catalog = await getMcpCatalog();
  const unreachable: UnreachableServer[] = catalog.servers
    .filter((s) => s.status !== 'connected')
    .map((s) => ({
      name: s.name,
      status: s.status,
      ...(s.errorMessage ? { message: s.errorMessage } : {}),
    }));
  return { missingDeclared, unreachable };
}
