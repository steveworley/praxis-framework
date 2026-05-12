import { z } from 'zod';

/**
 * Output taxonomy — framework-level schema for role work product.
 *
 * Five primitives chosen to cover most knowledge-work outputs across role
 * types without forcing each role to define its own taxonomy:
 *
 *   - document   long-form prose (briefs, notes, analyses)
 *   - draft      outgoing communication (an email, a Slack DM, a letter)
 *   - record     observation tied to an entity (an account read, a call log)
 *   - plan       multi-step intent the role committed to (checklist body)
 *   - reference  reusable knowledge worth keeping (a heuristic, a recipe)
 *
 * Status is a closed enum framework-wide. The five types share the same
 * lifecycle (draft → review → ready → sent → done → archived). Not every
 * status applies to every type; the dashboard surfaces only the relevant
 * subset for each type but the data layer doesn't constrain it — the model
 * (and operator) pick. This file is the registry the tools, the loader, the
 * API routes and the dashboard renderers all consult.
 *
 * The shape is mirrored verbatim in `template/lib/output-schemas.yaml` for
 * operator reading. That YAML is documentation, not the authoritative
 * registry — runtime code reads `OUTPUT_TYPES` below.
 */

// ---- Closed enums --------------------------------------------------------

export const STATUS_ENUM = [
  'draft',
  'review',
  'ready',
  'sent',
  'done',
  'archived',
] as const;
export type OutputStatus = (typeof STATUS_ENUM)[number];

export const DRAFT_CHANNEL_ENUM = [
  'email',
  'slack',
  'dm',
  'letter',
  'call',
  'other',
] as const;
export type DraftChannel = (typeof DRAFT_CHANNEL_ENUM)[number];

export const OUTPUT_TYPE_ENUM = [
  'document',
  'draft',
  'record',
  'plan',
  'reference',
] as const;
export type OutputType = (typeof OUTPUT_TYPE_ENUM)[number];

// ---- Slug + entity-id regex ---------------------------------------------

/** Lowercase letters/digits/hyphens, must start alphanumeric. Path-safe. */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---- Registry -----------------------------------------------------------

/**
 * Per-type structural metadata. `required` and `optional` enumerate the
 * type-specific frontmatter fields (i.e. on top of the universal `type`,
 * `slug`, `status`, `created`, `updated` fields every entry carries).
 * `pathTemplate` is a sprintf-ish form with `{name}` placeholders; the
 * loader and write tool both resolve paths from this single source.
 */
export interface OutputTypeSpec {
  readonly required: readonly string[];
  readonly optional: readonly string[];
  readonly pathTemplate: string;
  /** Channel enum for drafts; absent on other types. */
  readonly channelEnum?: readonly string[];
}

export const OUTPUT_TYPES: { readonly [K in OutputType]: OutputTypeSpec } = {
  document: {
    required: ['title'],
    optional: ['audience'],
    pathTemplate: 'output/document/{slug}.md',
  },
  draft: {
    required: [],
    optional: ['recipient', 'channel', 'subject'],
    channelEnum: DRAFT_CHANNEL_ENUM,
    pathTemplate: 'output/draft/{slug}.md',
  },
  record: {
    required: ['entity_type', 'entity_id', 'observed_at'],
    optional: [],
    pathTemplate: 'output/record/{entity_type}/{entity_id}/{slug}.md',
  },
  plan: {
    required: ['goal'],
    optional: ['owner'],
    pathTemplate: 'output/plan/{slug}.md',
  },
  reference: {
    required: ['topic'],
    optional: ['tags'],
    pathTemplate: 'output/reference/{slug}.md',
  },
} as const;

// ---- Frontmatter shapes -------------------------------------------------

interface CommonMeta {
  type: OutputType;
  slug: string;
  status: OutputStatus;
  created: string;
  updated: string;
}

export interface DocumentMeta extends CommonMeta {
  type: 'document';
  title: string;
  audience?: string;
}

export interface DraftMeta extends CommonMeta {
  type: 'draft';
  recipient?: string;
  channel?: DraftChannel;
  subject?: string;
}

export interface RecordMeta extends CommonMeta {
  type: 'record';
  entity_type: string;
  entity_id: string;
  observed_at: string;
}

export interface PlanMeta extends CommonMeta {
  type: 'plan';
  goal: string;
  owner?: string;
}

export interface ReferenceMeta extends CommonMeta {
  type: 'reference';
  topic: string;
  tags?: string[];
}

export type OutputMeta =
  | DocumentMeta
  | DraftMeta
  | RecordMeta
  | PlanMeta
  | ReferenceMeta;

// ---- Summary type (used by listings) ------------------------------------

/**
 * Listing-shape projection. `path` is the role-relative path. `title`
 * resolves to the type-appropriate display label (document.title /
 * draft.subject / record.entity_id:slug / plan.goal / reference.topic),
 * falling back to the slug.
 */
export interface OutputSummary {
  type: OutputType;
  slug: string;
  status: OutputStatus;
  created: string;
  updated: string;
  path: string;
  title: string;
  /** Type-specific extras, e.g. {recipient, channel} for drafts. */
  extras: Record<string, string | string[]>;
}

// ---- Zod schemas for runtime validation ---------------------------------

const StatusSchema = z.enum(STATUS_ENUM);
const ChannelSchema = z.enum(DRAFT_CHANNEL_ENUM);
const SlugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(SLUG_RE, 'must be lowercase letters/digits/hyphens, starting with alphanumeric');

const Tags = z.array(z.string().trim().min(1).max(40)).max(20);

/** Per-type frontmatter validation (server-side, used by the write tool). */
export const DocumentFieldsSchema = z.object({
  title: z.string().trim().min(1).max(200),
  audience: z.string().trim().min(1).max(200).optional(),
});

export const DraftFieldsSchema = z.object({
  recipient: z.string().trim().min(1).max(200).optional(),
  channel: ChannelSchema.optional(),
  subject: z.string().trim().min(1).max(200).optional(),
});

export const RecordFieldsSchema = z.object({
  entity_type: SlugSchema,
  entity_id: SlugSchema,
  observed_at: z.string().trim().min(1).max(40),
});

export const PlanFieldsSchema = z.object({
  goal: z.string().trim().min(1).max(400),
  owner: z.string().trim().min(1).max(120).optional(),
});

export const ReferenceFieldsSchema = z.object({
  topic: z.string().trim().min(1).max(200),
  tags: Tags.optional(),
});

/**
 * Map a runtime type label to its Zod schema. Centralised so tools and
 * loader can validate without re-importing each.
 */
export function fieldsSchemaFor(type: OutputType): z.ZodTypeAny {
  switch (type) {
    case 'document':
      return DocumentFieldsSchema;
    case 'draft':
      return DraftFieldsSchema;
    case 'record':
      return RecordFieldsSchema;
    case 'plan':
      return PlanFieldsSchema;
    case 'reference':
      return ReferenceFieldsSchema;
  }
}

export { StatusSchema, ChannelSchema, SlugSchema };

// ---- Path resolution ----------------------------------------------------

/**
 * Resolve the relative path for an output entry from its type, slug, and
 * (for records) the entity context. Validates each path segment against
 * SLUG_RE so no traversal sequence (`..`, `/etc/passwd`) can sneak through.
 *
 * Throws a typed error on shape mismatch so callers can catch it cleanly
 * and surface the model-readable refusal.
 */
export class OutputPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputPathError';
  }
}

export interface ResolvePathArgs {
  type: OutputType;
  slug: string;
  entity_type?: string;
  entity_id?: string;
}

export function resolveOutputPath(args: ResolvePathArgs): string {
  const spec = OUTPUT_TYPES[args.type];
  if (!SLUG_RE.test(args.slug)) {
    throw new OutputPathError(`Invalid slug: '${args.slug}' must match ${SLUG_RE}.`);
  }
  if (args.type === 'record') {
    if (!args.entity_type || !args.entity_id) {
      throw new OutputPathError(
        'record paths require entity_type and entity_id segments.',
      );
    }
    if (!SLUG_RE.test(args.entity_type)) {
      throw new OutputPathError(
        `Invalid entity_type: '${args.entity_type}' must match ${SLUG_RE}.`,
      );
    }
    if (!SLUG_RE.test(args.entity_id)) {
      throw new OutputPathError(
        `Invalid entity_id: '${args.entity_id}' must match ${SLUG_RE}.`,
      );
    }
  }
  return spec.pathTemplate
    .replace('{slug}', args.slug)
    .replace('{entity_type}', args.entity_type ?? '')
    .replace('{entity_id}', args.entity_id ?? '');
}
