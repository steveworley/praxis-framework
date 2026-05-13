import type { APIRoute } from 'astro';

import { renderMarkdown } from '@/lib/markdown';
import { getRoleHome } from '@/lib/role-home';
import { loadVerb } from '@/lib/verbs-loader';

/**
 * Read endpoint for a single live verb. Powers external tooling and the
 * /verbs/[slug] page's JSON contract — the page loads via `loadVerb` directly
 * server-side, so this route exists for parity (callers polling for verb
 * detail without a full page render).
 *
 *   200  → { slug, file, label, tag, frontmatter, body, body_html }
 *   400  → invalid slug (failed kebab-case validation)
 *   404  → verb file doesn't exist at verbs/<slug>.md
 */

export const prerender = false;

export const GET: APIRoute = async ({ params }) => {
  const slug = String(params['slug'] ?? '');
  try {
    const detail = await loadVerb(getRoleHome(), slug);
    if (!detail) {
      return json(404, { error: `Verb not found: ${slug}` });
    }
    return json(200, {
      slug: detail.slug,
      file: detail.file,
      label: detail.label,
      tag: detail.tag,
      frontmatter: detail.frontmatter,
      body: detail.body,
      body_html: renderMarkdown(detail.body),
    });
  } catch (error: unknown) {
    if (error instanceof Error && /Invalid verb slug/.test(error.message)) {
      return json(400, { error: error.message });
    }
    return json(500, { error: errorMessage(error) });
  }
};

function errorMessage(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
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
