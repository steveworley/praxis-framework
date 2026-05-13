import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetMcpCatalog } from './mcp-catalog.ts';
import { executeMcpCall } from './mcp-call.ts';

const originalFetch = globalThis.fetch;
let tempDir: string;

beforeEach(async () => {
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-call-'));
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
  await fs.rm(tempDir, { recursive: true, force: true });
  vi.useRealTimers();
});

async function writeAutonomy(text: string): Promise<void> {
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  await fs.writeFile(path.join(tempDir, 'lib', 'autonomy.yaml'), text, 'utf-8');
}

function mockTwoStage(
  listResponse: Response | (() => Promise<Response>),
  callResponse: Response | (() => Promise<Response>) | (() => Promise<never>),
): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async (url: string | URL | Request) => {
    const u = String(url);
    if (u.endsWith('/tools/list')) {
      return typeof listResponse === 'function' ? listResponse() : listResponse;
    }
    if (u.endsWith('/tools/call')) {
      return typeof callResponse === 'function' ? callResponse() : callResponse;
    }
    throw new Error(`Unexpected fetch URL: ${u}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

function listOk(methods: { name: string; description?: string; inputSchema?: unknown }[]): Response {
  return new Response(
    JSON.stringify({ tools: methods.map((m) => ({ description: '', inputSchema: {}, ...m })) }),
    { status: 200 },
  );
}

describe('executeMcpCall — success', () => {
  it('returns a ToolSuccess with the MCP response data', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: allow\n');
    mockTwoStage(
      listOk([{ name: 'post_message' }]),
      new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'posted' }] }),
        { status: 200 },
      ),
    );

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {
      channel: '#general',
      text: 'hello',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.summary).toBe('slack__post_message');
    expect(result.data['mcp_server']).toBe('slack');
    expect(result.data['mcp_method']).toBe('post_message');
    expect(result.data['response']).toEqual({
      content: [{ type: 'text', text: 'posted' }],
    });
  });

  it('POSTs the args as the `arguments` field per MCP spec', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: allow\n');
    const fetchMock = mockTwoStage(
      listOk([{ name: 'post_message' }]),
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    await executeMcpCall(tempDir, 'slack', 'post_message', {
      channel: '#general',
      text: 'hi',
    });

    const callInvocation = fetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith('/tools/call'),
    );
    expect(callInvocation).toBeDefined();
    const body = JSON.parse(String(callInvocation?.[1]?.body));
    expect(body).toEqual({
      name: 'post_message',
      arguments: { channel: '#general', text: 'hi' },
    });
  });
});

describe('executeMcpCall — refusals', () => {
  it('refuses when the server is unknown (not in PRAXIS_MCPS)', async () => {
    process.env['PRAXIS_MCPS'] = '';
    await writeAutonomy('mcps:\n  slack: allow\n');
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not in PRAXIS_MCPS/);
  });

  it('refuses when the server is unreachable', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: allow\n');
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/unreachable/);
    expect(result.error).toContain('slack');
  });

  it('refuses on autonomy deny', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: deny\n');
    mockTwoStage(
      listOk([{ name: 'post_message' }]),
      new Response('{}', { status: 200 }),
    );

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/denied/);
    expect(result.error).toContain('slack');
  });

  it('refuses on default-deny when the server is absent from autonomy.yaml', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('# no mcps block\n');
    mockTwoStage(
      listOk([{ name: 'post_message' }]),
      new Response('{}', { status: 200 }),
    );

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/not declared/);
  });

  it('refuses on a non-200 from tools/call', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: allow\n');
    mockTwoStage(
      listOk([{ name: 'post_message' }]),
      new Response('boom', { status: 500 }),
    );

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/HTTP 500/);
  });

  it('refuses on isError: true in the MCP response body', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: allow\n');
    mockTwoStage(
      listOk([{ name: 'post_message' }]),
      new Response(
        JSON.stringify({
          isError: true,
          content: [{ type: 'text', text: 'channel not found' }],
        }),
        { status: 200 },
      ),
    );

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/errored/);
    expect(result.error).toContain('channel not found');
  });

  it('refuses on malformed (non-JSON) response body', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: allow\n');
    mockTwoStage(
      listOk([{ name: 'post_message' }]),
      new Response('not json at all', { status: 200 }),
    );

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/non-JSON/);
  });

  it('translates a fetch network failure into a ToolFailure', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    await writeAutonomy('mcps:\n  slack: allow\n');
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/tools/list')) {
        return listOk([{ name: 'post_message' }]);
      }
      throw new Error('socket hang up');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await executeMcpCall(tempDir, 'slack', 'post_message', {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/socket hang up/);
  });
});
