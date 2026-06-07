import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveTemplatePath } from './template.js';
import { SeedError } from './types.js';

describe('resolveTemplatePath', () => {
  const created: string[] = [];

  afterEach(async () => {
    for (const dir of created.splice(0)) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('default (embedded) mode', () => {
    it('materialises the embedded scaffolding into a fresh temp dir', () => {
      const dir = resolveTemplatePath();
      created.push(dir);

      expect(existsSync(dir)).toBe(true);
      // Known scaffolding files sourced from the embedded template data.
      expect(existsSync(path.join(dir, 'persona.md'))).toBe(true);
      expect(existsSync(path.join(dir, 'lib', 'tools.yaml'))).toBe(true);
    });

    it('returns a fresh directory on each call', () => {
      const a = resolveTemplatePath();
      const b = resolveTemplatePath();
      created.push(a, b);
      expect(a).not.toBe(b);
    });
  });

  describe('override mode', () => {
    it('returns the resolved absolute path when the override exists', async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'praxis-override-'));
      created.push(dir);
      expect(resolveTemplatePath(dir)).toBe(path.resolve(dir));
    });

    it('throws TEMPLATE_MISSING when the override does not exist', () => {
      try {
        resolveTemplatePath('/nonexistent/praxis-template');
        throw new Error('expected resolveTemplatePath to throw');
      } catch (e: unknown) {
        expect(e).toBeInstanceOf(SeedError);
        expect((e as SeedError).code).toBe('TEMPLATE_MISSING');
      }
    });
  });
});
