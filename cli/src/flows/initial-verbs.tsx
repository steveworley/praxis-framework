import React, { useState } from 'react';
import { Box, Text } from 'ink';

import type { InitialVerb } from '../state/form.js';
import { ListBuilder, type FieldSpec } from '../ui/list-builder.js';
import { accent, muted } from '../ui/theme.js';

/**
 * Initial verbs flow — two stages, mirroring the voice flow.
 *
 *   1. Name the verbs — the operator authors 1-6 slugs in a `ListBuilder`.
 *      Slug is filename-shaped (`/^[a-z][a-z0-9-]*$/`); no body content
 *      yet, just the canonical token.
 *   2. Author bullets per verb — for each slug, a fresh `ListBuilder`
 *      collects 0-6 free-text bullets. The bullets render directly into
 *      the seeded `verbs/<slug>.md` file's body, so a slug with no
 *      bullets ships a stub with a TODO marker.
 *
 * The split mirrors the {trait, qualifiers} shape — slug is *what* the
 * verb is (canonical, filename-shaped), description is *how* it behaves
 * (free-form, bullet-shaped). Authoring them separately keeps each stage
 * focused: the operator picks names first, then expands each one with
 * the body text without juggling slug-validity and prose at once.
 */

interface Props {
  initial: InitialVerb[];
  onNext: (verbs: InitialVerb[]) => void;
  onCancel: () => void;
}

const MIN_VERBS = 1;
const MAX_VERBS = 6;
const MAX_BULLETS_PER_VERB = 6;
const SLUG_RE = /^[a-z][a-z0-9-]*$/;

type Stage =
  | { kind: 'name'; verbs: InitialVerb[] }
  | { kind: 'author'; verbs: InitialVerb[]; cursor: number };

export const InitialVerbsFlow = ({ initial, onNext, onCancel }: Props) => {
  const [stage, setStage] = useState<Stage>({
    kind: 'name',
    verbs: initial.length > 0 ? initial : [],
  });

  if (stage.kind === 'name') {
    return (
      <NameVerbs
        initial={stage.verbs}
        onCancel={onCancel}
        onNext={(verbs) => {
          setStage({ kind: 'author', verbs, cursor: 0 });
        }}
      />
    );
  }

  // Authoring stage — one verb at a time. Cursor is bounded by the verb
  // list we just built, so an out-of-range cursor would be a bug rather
  // than a user-reachable state.
  const verb = stage.verbs[stage.cursor];
  if (!verb) {
    return (
      <Box>
        <Text color="red">Internal: verb cursor out of range — please cancel and retry.</Text>
      </Box>
    );
  }

  return (
    <AuthorBullets
      slug={verb.slug}
      position={stage.cursor + 1}
      total={stage.verbs.length}
      initial={verb.description}
      onCancel={() => setStage({ kind: 'name', verbs: stage.verbs })}
      onNext={(description) => {
        const nextVerbs = stage.verbs.map((v, i) =>
          i === stage.cursor ? { ...v, description } : v,
        );
        if (stage.cursor === stage.verbs.length - 1) {
          onNext(nextVerbs);
          return;
        }
        setStage({ kind: 'author', verbs: nextVerbs, cursor: stage.cursor + 1 });
      }}
    />
  );
};

// ---------------------------------------------------------------------------
// Stage 1: name the verbs
// ---------------------------------------------------------------------------

interface SlugRow {
  slug: string;
}

const SLUG_FIELDS: FieldSpec<SlugRow>[] = [
  {
    key: 'slug',
    label: 'slug',
    placeholder: 'e.g. account-curator',
    extract: (r) => r.slug,
    apply: (r, value) => ({ ...r, slug: value }),
  },
];

interface NameVerbsProps {
  initial: InitialVerb[];
  onNext: (verbs: InitialVerb[]) => void;
  onCancel: () => void;
}

const NameVerbs = ({ initial, onNext, onCancel }: NameVerbsProps) => {
  // Seed slug rows from any prior pass; carry their authored descriptions
  // forward via a side map so backing out of stage 2 doesn't lose work.
  const initialRows: SlugRow[] = initial.map((v) => ({ slug: v.slug }));
  const priorDescriptions = new Map<string, string[]>(
    initial.map((v) => [v.slug, [...v.description]]),
  );

  return (
    <ListBuilder<SlugRow>
      title="Initial verbs — name the verbs"
      helper={`The first verbs the role will run. Slug is filename-shaped (lowercase letters, digits, hyphens; starts with a letter). ${MIN_VERBS}-${MAX_VERBS} verbs. You'll author the bullets for each one in the next step.`}
      initial={initialRows}
      fields={SLUG_FIELDS}
      empty={() => ({ slug: '' })}
      validate={(r) => {
        const slug = r.slug.trim();
        if (slug.length === 0) return 'slug is required';
        if (!SLUG_RE.test(slug)) {
          return 'slug must be lowercase letters, digits, and hyphens (start with a letter)';
        }
        return null;
      }}
      min={MIN_VERBS}
      max={MAX_VERBS}
      onNext={(rows) => {
        const verbs: InitialVerb[] = rows.map((r) => {
          const slug = r.slug.trim();
          return {
            slug,
            description: priorDescriptions.get(slug) ?? [],
          };
        });
        onNext(verbs);
      }}
      onCancel={onCancel}
    />
  );
};

// ---------------------------------------------------------------------------
// Stage 2: author bullets per verb
// ---------------------------------------------------------------------------

interface BulletRow {
  text: string;
}

const BULLET_FIELDS: FieldSpec<BulletRow>[] = [
  {
    key: 'text',
    label: 'bullet',
    placeholder: 'one bullet describing what this verb does (or leave blank to skip)',
    extract: (r) => r.text,
    apply: (r, value) => ({ ...r, text: value }),
  },
];

interface AuthorBulletsProps {
  slug: string;
  position: number;
  total: number;
  initial: string[];
  onNext: (description: string[]) => void;
  onCancel: () => void;
}

const AuthorBullets = ({
  slug,
  position,
  total,
  initial,
  onNext,
  onCancel,
}: AuthorBulletsProps) => {
  const initialRows: BulletRow[] = initial.map((text) => ({ text }));

  return (
    <Box flexDirection="column">
      <Box>
        <Text>{muted(`verb ${position} of ${total}`)}</Text>
      </Box>
      <Box>
        <Text>
          {accent('→ ')}
          {accent(slug)}
        </Text>
      </Box>
      <Box marginBottom={1}>
        <Text>{muted('Author the bullets that describe what this verb does.')}</Text>
      </Box>

      <ListBuilder<BulletRow>
        // Remount per verb so the in-progress draft input doesn't bleed
        // across verbs — `ListBuilder` seeds its state from `initial` only
        // on first mount, so a parent-driven prop swap alone isn't enough.
        key={slug}
        title=""
        helper=""
        initial={initialRows}
        fields={BULLET_FIELDS}
        empty={() => ({ text: '' })}
        validate={(r) => (r.text.trim().length === 0 ? 'bullet text is required' : null)}
        min={0}
        max={MAX_BULLETS_PER_VERB}
        onNext={(rows) => onNext(rows.map((r) => r.text.trim()).filter((t) => t.length > 0))}
        onCancel={onCancel}
      />

      <Box marginTop={1}>
        <Text dimColor>
          Tip: enter on the last (or empty) row advances to the next verb. Esc returns to the slug list.
        </Text>
      </Box>
    </Box>
  );
};
