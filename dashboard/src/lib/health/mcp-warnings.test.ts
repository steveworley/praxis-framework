import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetMcpCatalog, _setTransportFactory } from '@/lib/chat/mcp-catalog.ts';

import { assembleMcpWarnings } from './mcp-warnings.ts';

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-warn-'));
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
});

afterEach(async () => {
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * Transport factory backing a healthy in-process MCP server. Registers a
 * single no-op tool — an `McpServer` with zero tools doesn't advertise the
 * `tools` capability, so `listTools` would fault; one tool makes the connect
 * genuinely healthy without affecting the warning assertions.
 */
function healthyFactory(): () => Transport {
  return () => {
    const server = new McpServer({ name: 'warn-test', version: '0.0.0' });
    server.registerTool(
      'ping',
      { description: 'noop', inputSchema: {} },
      async () => ({ content: [{ type: 'text', text: 'pong' }] }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    return clientTransport;
  };
}

/** Transport factory whose connect rejects — a dead/unreachable server. */
function unreachableFactory(message: string): () => Transport {
  return () => ({
    async start(): Promise<void> {
      throw new Error(message);
    },
    async send(): Promise<void> {},
    async close(): Promise<void> {},
  });
}

/**
 * Write a minimal `tools.yaml` that declares the given MCP capabilities under
 * a `capabilities:` map. Each declared name lands as `mcp:<name>`; non-MCP
 * names are passed through verbatim.
 */
async function writeToolsYaml(declarations: readonly string[]): Promise<void> {
  const body =
    `capabilities:\n` +
    declarations
      .map((name) => `  ${name}:\n    description: ${name}`)
      .join('\n') +
    '\n';
  await fs.writeFile(path.join(tempDir, 'lib', 'tools.yaml'), body, 'utf-8');
}

describe('assembleMcpWarnings', () => {
  it('clean state: no declared capabilities, no configured servers', async () => {
    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual([]);
    expect(result.unreachable).toEqual([]);
  });

  it('clean state: tools.yaml absent (no lib/ entries)', async () => {
    await fs.rm(path.join(tempDir, 'lib'), { recursive: true });
    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual([]);
    expect(result.unreachable).toEqual([]);
  });

  it('clean state: declared MCPs all match PRAXIS_MCPS and respond healthy', async () => {
    await writeToolsYaml(['mcp:slack']);
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    _setTransportFactory(healthyFactory());

    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual([]);
    expect(result.unreachable).toEqual([]);
  });

  it('only-missing-declared: tools.yaml declares mcp:foo but PRAXIS_MCPS is unset', async () => {
    await writeToolsYaml(['mcp:google-workspace', 'mcp:slack']);
    // PRAXIS_MCPS unset — both declared servers are missing, no servers to
    // mark unreachable.
    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual(['google-workspace', 'slack']);
    expect(result.unreachable).toEqual([]);
  });

  it('only-unreachable: PRAXIS_MCPS points to a dead server, no MCP declarations', async () => {
    await writeToolsYaml(['fs:read']);
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    _setTransportFactory(unreachableFactory('connect ECONNREFUSED'));

    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual([]);
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0]?.name).toBe('slack');
    expect(result.unreachable[0]?.status).toBe('unreachable');
    expect(result.unreachable[0]?.message).toContain('ECONNREFUSED');
  });

  it('both: one declared-but-missing server and one configured-but-unreachable server', async () => {
    await writeToolsYaml(['mcp:gmail', 'mcp:slack']);
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    _setTransportFactory(unreachableFactory('boom'));

    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual(['gmail']);
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0]?.name).toBe('slack');
    expect(result.unreachable[0]?.status).toBe('unreachable');
  });

  it('surfaces the catalog error string on an unreachable server', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    // A failed MCP connect carries the transport's error message through to
    // the warning entry, so the operator sees *why* the server is down.
    _setTransportFactory(unreachableFactory('handshake rejected: 503'));

    const result = await assembleMcpWarnings(tempDir);
    expect(result.unreachable[0]?.status).toBe('unreachable');
    expect(result.unreachable[0]?.message).toContain('handshake rejected: 503');
  });
});
