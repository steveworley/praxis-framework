import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetMcpCatalog, _setTransportFactory } from './mcp-catalog.ts';
import { executeMcpCall } from './mcp-call.ts';

/**
 * `executeMcpCall` is now only the autonomy gate + error translation — the
 * transport (a stateful per-server MCP `Client`) is owned by the catalog. We
 * drive a real in-process `McpServer` over an in-memory transport pair via the
 * catalog's `_setTransportFactory` seam, so these tests exercise the genuine
 * SDK round-trip (listTools at connect, callTool on dispatch) rather than a
 * mocked HTTP shape.
 */

let tempDir: string;

/**
 * In-process MCP server advertising `post_message` (echoes its args) and
 * `boom` (returns `isError: true`). The factory returns a fresh linked
 * transport per catalog connect, bound to the same tool set.
 */
function buildMcpServerFactory(): () => Transport {
  return () => {
    const server = new McpServer({ name: 'slack-test', version: '0.0.0' });
    server.registerTool(
      'post_message',
      {
        description: 'Post a message',
        inputSchema: { channel: z.string(), text: z.string() },
      },
      async ({ channel, text }) => ({
        content: [{ type: 'text', text: `posted to ${channel}: ${text}` }],
        structuredContent: { channel, text },
      }),
    );
    server.registerTool(
      'boom',
      { description: 'Always errors', inputSchema: {} },
      async () => ({
        isError: true,
        content: [{ type: 'text', text: 'channel not found' }],
      }),
    );
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    void server.connect(serverTransport);
    return clientTransport;
  };
}

/** Transport whose connect fails — simulates an unreachable server. */
function unreachableFactory(message: string): () => Transport {
  return () => ({
    async start(): Promise<void> {
      throw new Error(message);
    },
    async send(): Promise<void> {},
    async close(): Promise<void> {},
  });
}

beforeEach(async () => {
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-call-'));
});

afterEach(async () => {
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
  await fs.rm(tempDir, { recursive: true, force: true });
});

async function writeAutonomy(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'autonomy.yaml'), text, 'utf-8');
}

describe('executeMcpCall — success', () => {
  it('returns a ToolSuccess with the MCP response data', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    await writeAutonomy('mcps:\n  slack: allow\n');
    _setTransportFactory(buildMcpServerFactory());

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {
      channel: '#general',
      text: 'hello',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toBe('slack__post_message');
    expect(result.data['mcp_server']).toBe('slack');
    expect(result.data['mcp_method']).toBe('post_message');
    // The full MCP CallToolResult is stashed under `response` verbatim.
    const response = result.data['response'] as Record<string, unknown>;
    expect(response['content']).toEqual([
      { type: 'text', text: 'posted to #general: hello' },
    ]);
  });

  it('passes the args through to the MCP tool as its arguments', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    await writeAutonomy('mcps:\n  slack: allow\n');
    _setTransportFactory(buildMcpServerFactory());

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {
      channel: '#general',
      text: 'hi',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const response = result.data['response'] as Record<string, unknown>;
    // The in-process tool echoes its args into structuredContent — proof the
    // arguments arrived intact through the real MCP round-trip.
    expect(response['structuredContent']).toEqual({
      channel: '#general',
      text: 'hi',
    });
  });
});

describe('executeMcpCall — refusals', () => {
  it('refuses when the server is unknown (not in PRAXIS_MCPS)', async () => {
    process.env['PRAXIS_MCPS'] = '';
    await writeAutonomy('mcps:\n  slack: allow\n');

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not in PRAXIS_MCPS/);
  });

  it('refuses when the server is unreachable', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    await writeAutonomy('mcps:\n  slack: allow\n');
    _setTransportFactory(unreachableFactory('connect ECONNREFUSED'));

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unreachable/);
    expect(result.error).toContain('slack');
  });

  it('refuses on autonomy deny', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    await writeAutonomy('mcps:\n  slack: deny\n');
    _setTransportFactory(buildMcpServerFactory());

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/denied/);
    expect(result.error).toContain('slack');
  });

  it('refuses on default-deny when the server is absent from autonomy.yaml', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    await writeAutonomy('# no mcps block\n');
    _setTransportFactory(buildMcpServerFactory());

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not declared/);
  });

  it('refuses on isError: true in the MCP tool result', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    await writeAutonomy('mcps:\n  slack: allow\n');
    _setTransportFactory(buildMcpServerFactory());

    const result = await executeMcpCall(tempDir, 'slack', 'boom', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/errored/);
    expect(result.error).toContain('channel not found');
  });

  it('translates a transport failure into a ToolFailure', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080/mcp';
    await writeAutonomy('mcps:\n  slack: allow\n');
    // Connect succeeds (listTools returns one tool) but the call transport
    // dies mid-dispatch: a transport whose `send` rejects after a healthy
    // initialize/listTools handshake. We model this with a factory that
    // returns a working server, then close the client's transport before the
    // call by registering only a failing tool path. Simpler: register a tool
    // that throws on the server side, which the SDK surfaces as a tool error —
    // but to assert the *transport* path we drop the session instead.
    let serverRef: McpServer | undefined;
    _setTransportFactory(() => {
      const server = new McpServer({ name: 'slack-test', version: '0.0.0' });
      server.registerTool(
        'post_message',
        { description: 'Post', inputSchema: { channel: z.string() } },
        async () => ({ content: [{ type: 'text', text: 'ok' }] }),
      );
      serverRef = server;
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      void server.connect(serverTransport);
      return clientTransport;
    });

    // Force connect + listTools to populate the catalog.
    const { getMcpCatalog } = await import('./mcp-catalog.ts');
    const catalog = await getMcpCatalog();
    expect(catalog.servers[0]?.status).toBe('connected');

    // Kill the server side so the next callTool's transport send fails.
    await serverRef?.close();

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {
      channel: '#g',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/failed|unreachable/);
  });
});
