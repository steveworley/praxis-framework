import { describe, expect, it } from 'vitest';
import {
  CapabilitySchema,
  loadCatalog,
  parseCatalog,
  parseToolsYaml,
} from './catalog.js';

describe('loadCatalog', () => {
  it('loads the real template/lib/tools.yaml', async () => {
    const catalog = await loadCatalog();
    const names = catalog.capabilities.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'bash',
        'edit',
        'log',
        'mcp:filesystem',
        'mcp:google-workspace',
        'mcp:playwright',
        'mcp:slack',
        'websearch',
      ].sort(),
    );
  });

  it('builtins() returns only the always-available trio', async () => {
    const catalog = await loadCatalog();
    const builtins = catalog.builtins().map((c) => c.name).sort();
    expect(builtins).toEqual(['bash', 'edit', 'log']);
  });

  it('optional() returns the rest', async () => {
    const catalog = await loadCatalog();
    const optional = catalog.optional().map((c) => c.name).sort();
    expect(optional).toEqual(
      [
        'mcp:filesystem',
        'mcp:google-workspace',
        'mcp:playwright',
        'mcp:slack',
        'websearch',
      ].sort(),
    );
    for (const c of catalog.optional()) {
      expect(c.always_available).toBe(false);
    }
  });

  it('every entry validates against CapabilitySchema', async () => {
    const catalog = await loadCatalog();
    for (const cap of catalog.capabilities) {
      const result = CapabilitySchema.safeParse(cap);
      expect(result.success).toBe(true);
    }
  });

  it('mcp:google-workspace surfaces the documented metadata', async () => {
    const catalog = await loadCatalog();
    const gw = catalog.capabilities.find((c) => c.name === 'mcp:google-workspace');
    expect(gw).toBeDefined();
    expect(gw?.transport_options).toEqual(['stdio', 'sse', 'url']);
    expect(gw?.default_transport).toBe('stdio');
    expect(gw?.default_auth_env).toBe('GOOGLE_WORKSPACE_TOKEN');
    expect(gw?.docker_image).toBe('praxis/mcp-google-workspace:latest');
  });
});

describe('parseCatalog', () => {
  it('defaults always_available to false when omitted', () => {
    const text = [
      'capabilities:',
      '  websearch:',
      '    description: "Web search"',
      '    transport_options: [url]',
      '    default_transport: url',
    ].join('\n');
    const catalog = parseCatalog(text);
    expect(catalog.capabilities).toHaveLength(1);
    expect(catalog.capabilities[0]?.always_available).toBe(false);
    expect(catalog.builtins()).toHaveLength(0);
    expect(catalog.optional()).toHaveLength(1);
  });

  it('respects always_available: true', () => {
    const text = [
      'capabilities:',
      '  bash:',
      '    description: "Shell"',
      '    transport_options: [native]',
      '    default_transport: native',
      '    always_available: true',
    ].join('\n');
    const catalog = parseCatalog(text);
    expect(catalog.builtins()).toHaveLength(1);
    expect(catalog.optional()).toHaveLength(0);
  });

  it('throws on a missing required field', () => {
    const text = [
      'capabilities:',
      '  broken:',
      '    description: "no transports"',
      '    default_transport: native',
    ].join('\n');
    expect(() => parseCatalog(text)).toThrow(/broken/);
  });

  it('throws when no capabilities are defined', () => {
    expect(() => parseCatalog('capabilities:\n')).toThrow(/no capabilities/);
  });

  it('parses null default_auth_env', () => {
    const text = [
      'capabilities:',
      '  mcp:playwright:',
      '    description: "Browser"',
      '    transport_options: [stdio, sse]',
      '    default_transport: stdio',
      '    default_auth_env: null',
      '    docker_image: mcr.microsoft.com/playwright:v1.45.0-noble',
    ].join('\n');
    const catalog = parseCatalog(text);
    const cap = catalog.capabilities[0];
    expect(cap?.name).toBe('mcp:playwright');
    expect(cap?.default_auth_env).toBeNull();
    expect(cap?.docker_image).toBe('mcr.microsoft.com/playwright:v1.45.0-noble');
  });
});

describe('parseToolsYaml', () => {
  it('handles colon-bearing capability names', () => {
    const text = [
      'capabilities:',
      '  mcp:slack:',
      '    description: "Slack"',
      '    transport_options: [stdio]',
      '    default_transport: stdio',
    ].join('\n');
    const parsed = parseToolsYaml(text);
    expect(Object.keys(parsed)).toEqual(['mcp:slack']);
    expect(parsed['mcp:slack']?.['default_transport']).toBe('stdio');
  });

  it('strips quotes from string values', () => {
    const text = [
      'capabilities:',
      '  bash:',
      '    description: "Shell execution"',
      '    transport_options: [native]',
      '    default_transport: "native"',
    ].join('\n');
    const parsed = parseToolsYaml(text);
    expect(parsed['bash']?.['description']).toBe('Shell execution');
    expect(parsed['bash']?.['default_transport']).toBe('native');
  });

  it('parses inline list of strings', () => {
    const text = [
      'capabilities:',
      '  x:',
      '    transport_options: [stdio, sse, url]',
    ].join('\n');
    const parsed = parseToolsYaml(text);
    expect(parsed['x']?.['transport_options']).toEqual(['stdio', 'sse', 'url']);
  });

  it('skips comments and blank lines', () => {
    const text = [
      '# header comment',
      '',
      'capabilities:',
      '  # comment in middle',
      '  bash:',
      '',
      '    description: "Shell"',
      '    transport_options: [native]',
      '    default_transport: native',
    ].join('\n');
    const parsed = parseToolsYaml(text);
    expect(parsed['bash']?.['description']).toBe('Shell');
  });
});
