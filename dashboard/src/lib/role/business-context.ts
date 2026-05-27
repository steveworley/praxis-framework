import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/** A single business-context field: a stable key, a human label, prose value. */
export interface BusinessContextField {
  key: string;
  label: string;
  value: string;
}

export interface BusinessContext {
  version: number;
  business_context: BusinessContextField[];
}

/** Well-known core fields, in display order. Seeded; may be blank, never deleted. */
export const CORE_FIELDS: readonly { key: string; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'website', label: 'Website' },
  { key: 'sector', label: 'Sector' },
  { key: 'size', label: 'Size' },
  { key: 'what_we_do', label: 'What we do' },
  { key: 'who_we_serve', label: 'Who we serve' },
  { key: 'what_makes_us_different', label: 'What makes us different' },
];

/** Short scalar fields render inline; everything else renders as a subsection. */
export const SCALAR_KEYS: ReadonlySet<string> = new Set(['name', 'website', 'sector', 'size']);

const FieldSchema = z.object({
  key: z.string().trim().min(1),
  label: z.string().trim().min(1),
  value: z.string().default(''),
});

const BusinessContextSchema = z.object({
  version: z.number().int().default(1),
  business_context: z.array(FieldSchema),
});

export function parseBusinessContext(yaml: string): BusinessContext {
  const raw: unknown = parseYaml(yaml);
  return BusinessContextSchema.parse(raw);
}

export function serializeBusinessContext(bc: BusinessContext): string {
  return stringifyYaml(BusinessContextSchema.parse(bc));
}

/** Build a fresh business-context with the core fields blank (legacy on-ramp). */
export function emptyBusinessContext(): BusinessContext {
  return {
    version: 1,
    business_context: CORE_FIELDS.map((f) => ({ key: f.key, label: f.label, value: '' })),
  };
}

function filePath(roleHome: string): string {
  return path.join(roleHome, 'lib', 'business-context.yaml');
}

/** Load the file; returns null when the role predates this feature. */
export async function loadBusinessContext(roleHome: string): Promise<BusinessContext | null> {
  let text: string;
  try {
    text = await fs.readFile(filePath(roleHome), 'utf-8');
  } catch {
    return null;
  }
  return parseBusinessContext(text);
}

/** Write the file (no commit — the endpoint owns committing). */
export async function writeBusinessContext(roleHome: string, bc: BusinessContext): Promise<void> {
  const dir = path.dirname(filePath(roleHome));
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath(roleHome), serializeBusinessContext(bc), 'utf-8');
}
