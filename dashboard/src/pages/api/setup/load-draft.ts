import fs from 'node:fs/promises';
import path from 'node:path';

import type { APIRoute } from 'astro';

import { parsePersonaText } from '@/lib/persona-parser';
import { getRoleHome } from '@/lib/role-home';

export const prerender = false;

const DRAFT_REL = path.posix.join('.praxis', 'persona-draft.md');

export const GET: APIRoute = async () => {
  const roleHome = getRoleHome();
  const draftAbs = path.join(roleHome, DRAFT_REL);

  let text: string;
  try {
    text = await fs.readFile(draftAbs, 'utf-8');
  } catch (error: unknown) {
    if (isNotFound(error)) {
      return json(200, { kind: 'pending', expected_path: DRAFT_REL });
    }
    const message = error instanceof Error ? error.message : String(error);
    return json(500, { kind: 'error', message });
  }

  try {
    const persona = parsePersonaText(text);
    if (
      persona.voice.length === 0 &&
      persona.capabilities.length === 0 &&
      persona.inhibitions.length === 0 &&
      persona.initial_agents.length === 0
    ) {
      return json(200, {
        kind: 'error',
        message:
          'persona-draft.md exists but has no voice/capabilities/inhibitions/agents. Check the section headings match the brief.',
      });
    }
    return json(200, { kind: 'ready', persona });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return json(200, { kind: 'error', message: `Failed to parse draft: ${message}` });
  }
};

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}

function json(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}
