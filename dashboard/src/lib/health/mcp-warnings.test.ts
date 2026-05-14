import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { _resetMcpCatalog } from '@/lib/chat/mcp-catalog.ts';

import { assembleMcpWarnings } from './mcp-warnings.ts';

const originalFetch = globalThis.fetch;

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-mcp-warn-'));
  await fs.mkdir(path.join(tempDir, 'lib'), { recursive: true });
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
});

afterEach(async () => {
  globalThis.fetch = originalFetch;
  _resetMcpCatalog();
  delete process.env['PRAXIS_MCPS'];
  vi.useRealTimers();
  await fs.rm(tempDir, { recursive: true, force: true });
});

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
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ tools: [] }), { status: 200 }),
    ) as unknown as typeof fetch;

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
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED');
    }) as unknown as typeof fetch;

    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual([]);
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0]?.name).toBe('slack');
    expect(result.unreachable[0]?.status).toBe('unreachable');
    expect(result.unreachable[0]?.message).toContain('ECONNREFUSED');
  });

  it('both: one declared-but-missing server and one configured-but-unreachable server', async () => {
    await writeToolsYaml(['mcp:gmail', 'mcp:slack']);
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    const result = await assembleMcpWarnings(tempDir);
    expect(result.missingDeclared).toEqual(['gmail']);
    expect(result.unreachable).toHaveLength(1);
    expect(result.unreachable[0]?.name).toBe('slack');
    expect(result.unreachable[0]?.status).toBe('unreachable');
  });

  it('unreachable entries omit `message` when the catalog has no error string', async () => {
    process.env['PRAXIS_MCPS'] = 'slack=http://mcp-slack:8080';
    // Non-200 with empty body — the catalog records an HTTP-status error
    // message, so this exercises the message path; we then assert the message
    // field is present and well-formed.
    globalThis.fetch = vi.fn(
      async () => new Response('', { status: 500 }),
    ) as unknown as typeof fetch;

    const result = await assembleMcpWarnings(tempDir);
    expect(result.unreachable[0]?.status).toBe('error');
    expect(result.unreachable[0]?.message).toContain('HTTP 500');
  });
});
