import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _getParsedEntries,
  _resetMcpCatalog,
  _setTransportFactory,
  findMissingMcpDeclarations,
  getMcpCatalog,
  parsePraxisMcps,
} from './mcp-catalog.ts';

/**
 * Tests drive the real MCP SDK rather than mocking `fetch`: a tiny in-process
 * `McpServer` advertises a couple of tools (one normal, one returning
 * `isError`), wired to the catalog via `InMemoryTransport.createLinkedPair()`.
 * The catalog's transport factory is swapped (`_setTransportFactory`) so its
 * client connects to that in-memory server instead of opening a real socket.
 */

interface ServerHarness {
  /** Number of links handed out — one per catalog connect attempt. */
  connectCount: number;
}

/**
 * Build an in-process MCP server advertising `post_message` (normal) and
 * `boom` (returns `isError: true`). Returns a transport factory the catalog
 * can use plus a harness counting connect attempts. Each catalog connect gets
 * a fresh linked transport pair bound to the same server instance.
 */
function buildMcpServer(): { factory: () => Transport; harness: ServerHarness } {
  const harness: ServerHarness = { connectCount: 0 };
  const factory = (): Transport => {
    harness.connectCount += 1;
    const server = new McpServer({ name: 'test-server', version: '0.0.0' });
    server.registerTool(
      'post_message',
      {
        description: 'Post a message to a channel',
        inputSchema: { channel: z.string(), text: z.string() },
      },
      async ({ channel, text }) => ({
        content: [{ type: 'text', text: `posted to ${channel}: ${text}` }],
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
  return { factory, harness };
}

/** A transport factory whose `start()` rejects — simulates an unreachable server. */
function unreachableFactory(message: string): () => Transport {
  return () => {
    const transport: Transport = {
      async start(): Promise<void> {
        throw new Error(message);
      },
      async send(): Promise<void> {},
      async close(): Promise<void> {},
    };
    return transport;
  };
}

beforeEach(() => {
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
});

afterEach(() => {
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
});

describe('parsePraxisMcps', () => {
  it('returns empty for undefined / empty string', () => {
    expect(parsePraxisMcps(undefined)).toEqual([]);
    expect(parsePraxisMcps('')).toEqual([]);
    expect(parsePraxisMcps('   ')).toEqual([]);
  });

  it('parses a single entry', () => {
    expect(parsePraxisMcps('quant=http://mcp-quant:8080/mcp')).toEqual([
      { name: 'quant', url: 'http://mcp-quant:8080/mcp' },
    ]);
  });

  it('parses multiple comma-separated entries', () => {
    expect(
      parsePraxisMcps('slack=http://a:1/mcp,gmail=http://b:2/mcp,playwright=http://c:3/mcp'),
    ).toEqual([
      { name: 'slack', url: 'http://a:1/mcp' },
      { name: 'gmail', url: 'http://b:2/mcp' },
      { name: 'playwright', url: 'http://c:3/mcp' },
    ]);
  });

  it('trims whitespace around names and urls', () => {
    expect(parsePraxisMcps(' slack = http://x:1/mcp , gmail = http://y:2/mcp ')).toEqual([
      { name: 'slack', url: 'http://x:1/mcp' },
      { name: 'gmail', url: 'http://y:2/mcp' },
    ]);
  });

  it('drops malformed entries (missing `=`, empty parts)', () => {
    expect(parsePraxisMcps('justaname,=http://x:1,name=,ok=http://y:2/mcp')).toEqual([
      { name: 'ok', url: 'http://y:2/mcp' },
    ]);
  });

  it('drops names with characters outside Anthropic tool-name alphabet', () => {
    expect(parsePraxisMcps('bad name=http://x:1,good_name=http://y:2/mcp')).toEqual([
      { name: 'good_name', url: 'http://y:2/mcp' },
    ]);
  });

  it('keeps the first entry on duplicate names', () => {
    expect(parsePraxisMcps('slack=http://first,slack=http://second')).toEqual([
      { name: 'slack', url: 'http://first' },
    ]);
  });
});

describe('getMcpCatalog — env-var snapshot', () => {
  it('returns empty when PRAXIS_MCPS is unset', async () => {
    const catalog = await getMcpCatalog();
    expect(catalog.servers).toEqual([]);
    expect(catalog.tools).toEqual([]);
  });

  it('re-parses when PRAXIS_MCPS changes between calls', async () => {
    process.env['PRAXIS_MCPS'] = 'first=http://a:1/mcp';
    expect(_getParsedEntries().map((e) => e.name)).toEqual(['first']);

    process.env['PRAXIS_MCPS'] = 'second=http://b:2/mcp';
    expect(_getParsedEntries().map((e) => e.name)).toEqual(['second']);
  });
});

describe('getMcpCatalog — MCP connect + listTools', () => {
  it('marks a server connected and registers its tools after a successful listTools', async () => {
    process.env['PRAXIS_MCPS'] = 'quant=http://mcp-quant:8080/mcp';
    const { factory } = buildMcpServer();
    _setTransportFactory(factory);

    const catalog = await getMcpCatalog();
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers[0]?.name).toBe('quant');
    expect(catalog.servers[0]?.status).toBe('connected');
    expect(catalog.servers[0]?.toolCount).toBe(2);

    expect(catalog.tools).toHaveLength(2);
    const post = catalog.tools.find((t) => t.methodName === 'post_message');
    expect(post?.toolName).toBe('quant__post_message');
    expect(post?.serverName).toBe('quant');
    expect(post?.description).toBe('Post a message to a channel');
    // inputSchema passes through verbatim — the SDK emits JSON Schema from the
    // Zod shape, and we hand it to Anthropic unchanged.
    const schema = post?.inputSchema as Record<string, unknown>;
    expect(schema['type']).toBe('object');
    expect(schema['properties']).toMatchObject({
      channel: { type: 'string' },
      text: { type: 'string' },
    });
  });

  it('caches the result and does not reconnect on the second call', async () => {
    process.env['PRAXIS_MCPS'] = 'quant=http://mcp-quant:8080/mcp';
    const { factory, harness } = buildMcpServer();
    _setTransportFactory(factory);

    await getMcpCatalog();
    await getMcpCatalog();
    expect(harness.connectCount).toBe(1);
  });

  it('dedupes concurrent connects to the same server', async () => {
    process.env['PRAXIS_MCPS'] = 'quant=http://mcp-quant:8080/mcp';
    const { factory, harness } = buildMcpServer();
    _setTransportFactory(factory);

    const [a, b] = await Promise.all([getMcpCatalog(), getMcpCatalog()]);
    // A single in-flight connect serves both concurrent callers.
    expect(harness.connectCount).toBe(1);
    expect(a.servers[0]?.status).toBe('connected');
    expect(b.servers[0]?.status).toBe('connected');
  });

  it('marks a server unreachable when the transport fails to connect', async () => {
    process.env['PRAXIS_MCPS'] = 'quant=http://mcp-quant:8080/mcp';
    _setTransportFactory(unreachableFactory('connect ECONNREFUSED'));

    const catalog = await getMcpCatalog();
    expect(catalog.servers).toHaveLength(1);
    expect(catalog.servers[0]?.status).toBe('unreachable');
    expect(catalog.servers[0]?.toolCount).toBe(0);
    expect(catalog.servers[0]?.errorMessage).toContain('ECONNREFUSED');
    expect(catalog.tools).toEqual([]);
  });
});

describe('getMcpCatalog — retry debounce', () => {
  it('does not retry an unreachable server inside the debounce window', async () => {
    process.env['PRAXIS_MCPS'] = 'quant=http://mcp-quant:8080/mcp';
    let connects = 0;
    _setTransportFactory(() => {
      connects += 1;
      return {
        async start(): Promise<void> {
          throw new Error('boom');
        },
        async send(): Promise<void> {},
        async close(): Promise<void> {},
      };
    });

    await getMcpCatalog();
    expect(connects).toBe(1);
    // Second call within the debounce window — no retry.
    await getMcpCatalog();
    expect(connects).toBe(1);
  });

  it('reconnects an unreachable server after the cache is cleared (post-debounce equivalent)', async () => {
    process.env['PRAXIS_MCPS'] = 'quant=http://mcp-quant:8080/mcp';
    // First attempt fails; after a reset (standing in for the debounce window
    // elapsing) the next attempt connects to a healthy server.
    _setTransportFactory(unreachableFactory('first fail'));
    const first = await getMcpCatalog();
    expect(first.servers[0]?.status).toBe('unreachable');

    _resetMcpCatalog();
    process.env['PRAXIS_MCPS'] = 'quant=http://mcp-quant:8080/mcp';
    const { factory } = buildMcpServer();
    _setTransportFactory(factory);

    const retried = await getMcpCatalog();
    expect(retried.servers[0]?.status).toBe('connected');
    expect(retried.servers[0]?.toolCount).toBe(2);
  });
});

describe('findMissingMcpDeclarations', () => {
  it('returns empty when no capabilities are declared', () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://a:1/mcp';
    expect(findMissingMcpDeclarations([])).toEqual([]);
  });

  it('returns declared mcp:* capabilities not present in PRAXIS_MCPS', () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://a:1/mcp';
    expect(
      findMissingMcpDeclarations(['mcp:slack', 'mcp:gmail', 'mcp:playwright', 'bash']),
    ).toEqual(['gmail', 'playwright']);
  });

  it('returns empty when all declared mcps are configured', () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://a:1/mcp,gmail=http://b:2/mcp';
    expect(findMissingMcpDeclarations(['mcp:slack', 'mcp:gmail'])).toEqual([]);
  });

  it('ignores capabilities without the mcp: prefix', () => {
    process.env['PRAXIS_MCPS'] = '';
    expect(findMissingMcpDeclarations(['bash', 'edit', 'websearch'])).toEqual([]);
  });

  it('deduplicates repeated declarations', () => {
    process.env['PRAXIS_MCPS'] = '';
    expect(findMissingMcpDeclarations(['mcp:slack', 'mcp:slack'])).toEqual(['slack']);
  });
});
