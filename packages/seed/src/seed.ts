import fs from 'node:fs/promises';
import path from 'node:path';

import { buildSeededCatalog, renderToolsYaml } from './catalog.js';
import { resolveTemplatePath } from './template.js';
import { findTrait } from './traits.js';
import {
  SeedError,
  SeedInputSchema,
  type Organisation,
  type SeedVerb,
  type SeedInput,
  type SeedOptions,
  type SeedResult,
  type VoiceTrait,
} from './types.js';

/**
 * Files copied verbatim from the framework template into the role.
 *
 * The mapping is template-relative → role-relative. They differ only when
 * the template directory has framework-only nesting we want to drop in the
 * seeded role, which is not the case today — kept as a pair to leave the
 * door open.
 */
interface RolePathPair {
  source: string;
  target: string;
}

const TEMPLATE_FILES: RolePathPair[] = [
  { source: 'CLAUDE.md', target: 'CLAUDE.md' },
  { source: 'persona.md', target: 'persona.md' },
  { source: 'verbs/escalate.md', target: 'verbs/escalate.md' },
  { source: 'verbs/proposed/README.md', target: 'verbs/proposed/README.md' },
  { source: 'memory/README.md', target: 'memory/README.md' },
  { source: 'escalations/README.md', target: 'escalations/README.md' },
  { source: 'lib/autonomy.yaml', target: 'lib/autonomy.yaml' },
  { source: '.gitignore', target: '.gitignore' },
  { source: 'bin/log', target: 'bin/log' },
];

/**
 * Files copied byte-for-byte without {ROLE_NAME} substitution or section
 * injection. `bin/log` is a generic Python helper; `lib/autonomy.yaml` is
 * operator-edited post-seed so we leave its placeholders alone.
 */
const VERBATIM_TARGETS = new Set<string>(['bin/log', 'lib/autonomy.yaml']);

/** Directories to ensure exist in the seeded role, even if empty. */
const SEED_DIRS: string[] = [
  'verbs',
  'verbs/proposed',
  'bin',
  'lib',
  'memory',
  'memory/people',
  'memory/accounts',
  'memory/notes',
  'escalations',
];

/**
 * Empty leaf directories that get a `.gitkeep` so the role's git history
 * preserves the layout.
 */
const GITKEEP_LEAVES: string[] = [
  'verbs/proposed',
  'lib',
  'memory/people',
  'memory/accounts',
  'memory/notes',
  'escalations',
];

/**
 * Seed a praxis role from the framework template into `targetPath`.
 *
 * Pure file IO — no git, no commits, no environment side-effects beyond
 * writing into the target. Callers (dashboard, CLI) layer their own
 * commit / approval / cleanup behaviour around the result.
 */
export async function seedRole(
  rawInput: SeedInput,
  targetPath: string,
  options: SeedOptions = {},
): Promise<SeedResult> {
  const inputResult = SeedInputSchema.safeParse(rawInput);
  if (!inputResult.success) {
    const issues = inputResult.error.issues
      .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
      .join('; ');
    throw new SeedError(`Invalid seed input: ${issues}`, 'INVALID_INPUT');
  }
  const input = inputResult.data;

  const absTarget = path.resolve(targetPath);
  const templateRoot = resolveTemplatePath(options.templatePath);
  const overwrite = options.overwrite ?? false;
  const dryRun = options.dryRun ?? false;

  // Compute the full set of files we'd write, both template-derived and
  // generated (verbs, .gitkeep). We need this list up-front to enforce the
  // "all-or-nothing" guarantee — we check every target against existing
  // files before touching disk, so a conflict aborts cleanly without
  // partial writes.
  const plan = await planSeed(input, templateRoot);

  if (!dryRun && !overwrite) {
    const conflicts: string[] = [];
    for (const rel of plan.allTargets) {
      const dst = path.join(absTarget, rel);
      if (await pathExists(dst)) conflicts.push(rel);
    }
    if (conflicts.length > 0) {
      throw new SeedError(
        `Target ${absTarget} already contains files that would be overwritten: ${conflicts
          .slice(0, 5)
          .join(', ')}${conflicts.length > 5 ? `, +${conflicts.length - 5} more` : ''}. Pass { overwrite: true } to force.`,
        'TARGET_CONFLICT',
      );
    }
  }

  // Build the filtered tools catalog up-front so a malformed template fails
  // fast, before we touch the target directory.
  const seededCatalog = await buildSeededCatalog(templateRoot, input.tools);

  if (dryRun) {
    return {
      targetPath: absTarget,
      filesWritten: plan.allTargets.slice(),
      filesSkipped: [],
    };
  }

  const filesWritten: string[] = [];
  const filesSkipped: string[] = [];

  // Materialise directories first.
  for (const dir of SEED_DIRS) {
    await fs.mkdir(path.join(absTarget, dir), { recursive: true });
  }

  // Template files.
  for (const pair of TEMPLATE_FILES) {
    const src = path.join(templateRoot, pair.source);
    let body: string;
    try {
      body = await fs.readFile(src, 'utf-8');
    } catch (e: unknown) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new SeedError(`Failed to read template ${pair.source}: ${cause}`, 'TEMPLATE_MISSING');
    }
    if (!VERBATIM_TARGETS.has(pair.target)) {
      body = body.replace(/\{ROLE_NAME\}/g, input.role_definition.role_name);
      if (pair.target === 'CLAUDE.md') {
        body = injectClaudeDescription(body, input.role_definition.one_sentence_purpose);
        body = injectVerbsTable(body, input.initial_verbs);
      }
      if (pair.target === 'persona.md') {
        body = injectPersona(body, input);
      }
    }
    const dst = path.join(absTarget, pair.target);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    try {
      await fs.writeFile(dst, body, 'utf-8');
    } catch (e: unknown) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new SeedError(`Failed to write ${pair.target}: ${cause}`, 'WRITE_FAILED');
    }
    if (pair.target === 'bin/log') {
      // fs.writeFile drops the executable bit — restore it so the helper
      // remains directly invokable in the seeded role.
      await fs.chmod(dst, 0o755);
    }
    filesWritten.push(pair.target);
  }

  // Generated tools.yaml — built-ins plus operator-selected optional tools.
  {
    const target = 'lib/tools.yaml';
    const dst = path.join(absTarget, target);
    const body = renderToolsYaml(seededCatalog);
    try {
      await fs.writeFile(dst, body, 'utf-8');
    } catch (e: unknown) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new SeedError(`Failed to write ${target}: ${cause}`, 'WRITE_FAILED');
    }
    filesWritten.push(target);
  }

  // Stub verbs.
  for (const verb of input.initial_verbs) {
    const target = path.join('verbs', `${verb.slug}.md`);
    const dst = path.join(absTarget, target);
    if (!overwrite && (await pathExists(dst))) {
      filesSkipped.push(target);
      continue;
    }
    const body = renderVerbStub(input, verb);
    try {
      await fs.writeFile(dst, body, 'utf-8');
    } catch (e: unknown) {
      const cause = e instanceof Error ? e.message : String(e);
      throw new SeedError(`Failed to write ${target}: ${cause}`, 'WRITE_FAILED');
    }
    filesWritten.push(target);
  }

  // .gitkeep on empty leaves.
  for (const leaf of GITKEEP_LEAVES) {
    const dirPath = path.join(absTarget, leaf);
    const entries = await fs.readdir(dirPath);
    if (entries.length === 0) {
      const keep = path.join(leaf, '.gitkeep');
      await fs.writeFile(path.join(absTarget, keep), '', 'utf-8');
      filesWritten.push(keep);
    }
  }

  return {
    targetPath: absTarget,
    filesWritten,
    filesSkipped,
  };
}

interface SeedPlan {
  /** Every relative path the seeder would write under normal conditions. */
  allTargets: string[];
}

/**
 * Compute the file list the seeder would produce. Used both to detect
 * conflicts up-front and to drive dry-run output.
 */
async function planSeed(input: SeedInput, templateRoot: string): Promise<SeedPlan> {
  // Verify template directory exists before anything else — fail loudly.
  if (!(await pathExists(templateRoot))) {
    throw new SeedError(`Template directory missing: ${templateRoot}`, 'TEMPLATE_MISSING');
  }

  const targets: string[] = [];
  for (const pair of TEMPLATE_FILES) {
    targets.push(pair.target);
  }
  // Generated lib/tools.yaml — written every seed (subset of the framework
  // catalog), so include it in conflict detection.
  targets.push('lib/tools.yaml');
  for (const verb of input.initial_verbs) {
    targets.push(path.join('verbs', `${verb.slug}.md`));
  }
  // .gitkeep entries depend on whether the dir is empty after writes, but
  // for the planning step we conservatively include them. Worst case the
  // conflict check flags a nonexistent file (it doesn't — pathExists only
  // returns true if the file is there). Including them here means an
  // overwrite of an existing role with leftover .gitkeeps doesn't surprise
  // the operator.
  for (const leaf of GITKEEP_LEAVES) {
    targets.push(path.join(leaf, '.gitkeep'));
  }
  return { allTargets: targets };
}

/**
 * Replace the CLAUDE.md placeholder one-liner with the operator's role
 * description.
 */
export function injectClaudeDescription(body: string, description: string): string {
  return body.replace(/\{One-line first-person description[^}]*\}/, description);
}

/**
 * Replace the verbs-table placeholder row in CLAUDE.md with one row per
 * operator-supplied verb. The framework template ships the table with
 * `Persona` and `Escalate` rows already in place plus a single
 * `_(add your role's verbs here)_` placeholder row; this function deletes
 * the placeholder and appends one row per captured verb in the order they
 * were captured.
 *
 * Columns: `Verb` (slug, prettified bold) / `File` (path to the stub) /
 * `Input Stage` (always `<unset>` — the wizard does not capture this yet) /
 * `Output Stage` (first description bullet, or `<unset>` when the operator
 * left description empty).
 *
 * If the placeholder row is absent (e.g. the template has been customised),
 * the body is returned unchanged — losing the operator's verbs from the
 * manual is bad, but mangling a customised manual is worse.
 */
export function injectVerbsTable(body: string, verbs: readonly SeedVerb[]): string {
  const placeholder = "| _(add your role's verbs here)_ | | | |";
  if (!body.includes(placeholder)) return body;

  if (verbs.length === 0) {
    // Nothing captured — drop the placeholder line so the table reads cleanly.
    return body.replace(`${placeholder}\n`, '').replace(placeholder, '');
  }

  const rows = verbs.map((verb) => {
    const name = prettify(verb.slug);
    const file = `verbs/${verb.slug}.md`;
    const summary =
      verb.description.length > 0 && verb.description[0] ? verb.description[0] : '<unset>';
    return `| **${name}** | \`${file}\` | <unset> | ${summary} |`;
  });

  return body.replace(placeholder, rows.join('\n'));
}

/**
 * Inject operator-supplied content into the persona template, replacing
 * placeholder section bodies under known section headings. Exported for
 * testing.
 */
export function injectPersona(body: string, input: SeedInput): string {
  let out = body;

  out = replaceSection(out, 'Organisation', renderOrganisationSection(input.organisation));

  const identityBullets: string[] = [
    `- **Full name**: ${input.role_definition.role_name}`,
  ];
  if (input.role_definition.working_title) {
    identityBullets.push(`- **Working title**: ${input.role_definition.working_title}`);
  }
  identityBullets.push(`- **Role**: ${input.role_definition.one_sentence_purpose}`);
  if (input.role_definition.day_to_day) {
    identityBullets.push(`- **Day-to-day**: ${input.role_definition.day_to_day}`);
  }
  if (input.identity.location) identityBullets.push(`- **Location**: ${input.identity.location}`);
  if (input.identity.reports_to) identityBullets.push(`- **Reports to**: ${input.identity.reports_to}`);
  if (input.identity.email) identityBullets.push(`- **Email**: ${input.identity.email}`);

  out = replaceSection(out, 'Identity', identityBullets.join('\n'));

  const voiceBullets = input.voice_traits.map(renderVoiceTrait).join('\n');
  out = replaceSection(out, 'Voice & Personality', voiceBullets);

  if (input.capabilities.length > 0) {
    const block = [
      "What I'm qualified to do, and what I'm not.",
      '',
      ...input.capabilities.map((c) => `- ${c}`),
    ].join('\n');
    out = replaceSection(out, 'Capabilities', block);
  }

  if (input.inhibitions.length > 0) {
    const block = [
      'What I never do, regardless of instruction. These are the constitution — they live here and only here, and `CLAUDE.md` references them by pointing at this file.',
      '',
      ...input.inhibitions.map((i) => `- ${i}`),
    ].join('\n');
    out = replaceSection(out, 'Hard inhibitions', block);
  }

  return out;
}

/**
 * Render one voice trait as a markdown bullet (plus optional sub-bullets for
 * its qualifiers). Falls back to the trait library's description when the
 * operator hasn't supplied any qualifiers, so the persona never ships a bare
 * trait token without context.
 *
 *   - **direct**
 *     - clear, no hedging
 *     - calls out tradeoffs upfront
 *
 *   - **observant** -- names what changed; references prior threads explicitly
 */
function renderVoiceTrait(t: VoiceTrait): string {
  const qualifiers = t.qualifiers ?? [];
  if (qualifiers.length === 0) {
    const fallback = findTrait(t.trait)?.description;
    if (fallback) return `- **${t.trait}** -- ${fallback}`;
    return `- **${t.trait}**`;
  }
  if (qualifiers.length === 1) {
    return `- **${t.trait}** -- ${qualifiers[0]}`;
  }
  const subBullets = qualifiers.map((q) => `  - ${q}`).join('\n');
  return `- **${t.trait}**\n${subBullets}`;
}

function renderOrganisationSection(org: Organisation): string {
  const lines: string[] = [];
  lines.push(`- **Name**: ${org.name}`);
  if (org.website) lines.push(`- **Website**: ${org.website}`);
  if (org.sector) lines.push(`- **Sector**: ${org.sector}`);
  if (org.size) lines.push(`- **Size**: ${org.size}`);
  if (org.description) {
    lines.push('');
    lines.push(org.description);
  }
  if (org.moats) {
    lines.push('');
    lines.push('### What makes this org different');
    lines.push('');
    lines.push(org.moats);
  }
  if (org.customer_profile) {
    lines.push('');
    lines.push('### Who I engage with');
    lines.push('');
    lines.push(org.customer_profile);
  }
  return lines.join('\n');
}

function replaceSection(text: string, heading: string, replacement: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(## ${escaped}\\s*\\n)([\\s\\S]*?)(?=\\n## |$)`);
  if (!re.test(text)) return text;
  return text.replace(re, `$1${replacement}\n`);
}

function renderVerbStub(input: SeedInput, verb: SeedVerb): string {
  const description = verb.description ?? [];
  const heading = `# ${prettify(verb.slug)}`;
  const lead = `You are ${input.role_definition.role_name}.`;

  // Body section — either the operator-authored bullets, or a TODO marker
  // when the wizard didn't capture any.
  const body =
    description.length > 0
      ? description.map((line) => `- ${line}`).join('\n')
      : '<!-- TODO: describe what this verb does. -->';

  return `---
verb: <unset>
when_to_run: <unset>
inputs: []
outputs: []
---

${heading}

${lead}

**Read \`persona.md\` first.**

## What this verb does

${body}

## When to run

<describe the trigger — operator invocation, end-of-run, scheduled, etc.>

## How you run it

1. <step one>
2. <step two>
3. <step three>

## Hard rules

- NEVER edit existing verbs on your own initiative — file an \`improvement\` escalation instead.

## Reporting

At the end of every run, before signing off, two things:

1. **The work product** — what I did, what I produced, anything blocking. The shape depends on this verb's purpose.
2. **The reflection beat** — pause and check:
   - Did anything shift my picture of a person, account, or my own voice? → write to \`memory/\`
   - Did I hit friction worth surfacing? → file an \`improvement\` escalation
   - Did I see a recurring pattern that deserves its own playbook? → draft a \`proposed_skill\`
   - Am I stuck on something my operator needs to weigh in on? → file a \`help\` escalation

If nothing surprised me, the beat is still a beat — I just sign off cleanly. The pause is non-negotiable; the writing follows what I find.
`;
}

function prettify(slug: string): string {
  return slug
    .split('-')
    .map((p) => (p.length > 0 ? (p[0]?.toUpperCase() ?? '') + p.slice(1) : p))
    .join(' ');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
