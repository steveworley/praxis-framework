import type Anthropic from '@anthropic-ai/sdk';

/**
 * The model's growth toolset for the chat surface. Four tools, each writing
 * into one of the role's growth surfaces:
 *
 *   - write_memory       → memory/<category>/<slug>.md
 *   - create_escalation  → escalations/<id>.md
 *   - propose_verb       → verbs/proposed/<slug>.md
 *   - log_decision       → logs/<date>.jsonl (or campaigns/.../logs/.jsonl)
 *
 * Each tool's input is validated server-side with Zod; this file is the
 * Anthropic-shaped description sent to the model so it knows what to call.
 *
 * Schemas are deliberately small and named for the role's natural language —
 * the model's prior over what each surface is for is stronger than any
 * schema doc, so descriptions reinforce *when* to use the tool rather than
 * exhaustively spelling out the file shape (which the executor handles).
 */

export const WRITE_MEMORY_TOOL: Anthropic.Tool = {
  name: 'write_memory',
  description:
    'Add a new entry to your persona-shaped notebook (memory/). Use this for ' +
    "observations worth remembering: a person calibration, an account that moved " +
    'unexpectedly, a voice shift you made, a small mistake you caught, a recurring ' +
    "pattern. The file is append-only — you can't overwrite an existing memory entry. " +
    'Pick a `category` from the directories that already exist under memory/ (e.g. ' +
    '"people", "accounts", "notes") or a new one if the entry truly does not fit any.',
  input_schema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        description:
          'Subdirectory under memory/ (e.g. "people", "accounts", "notes"). ' +
          'Lowercase letters, digits, hyphens. New categories are allowed.',
      },
      title: {
        type: 'string',
        description:
          'Human-readable title for the entry. Used as the H1 in the file and ' +
          'slugified for the filename (e.g. "Mary Chen at Acme" → mary-chen-at-acme.md).',
      },
      body: {
        type: 'string',
        description:
          'Markdown body of the entry. Be specific. Future-you should benefit from this ' +
          'without access to logs, structured files, or the dashboard.',
      },
    },
    required: ['category', 'title', 'body'],
  },
};

export const CREATE_ESCALATION_TOOL: Anthropic.Tool = {
  name: 'create_escalation',
  description:
    "File a structured ask for your operator. Three kinds: 'help' (stuck now, " +
    "can't continue without input — blocking), 'improvement' (process friction or " +
    "gap noticed — not blocking), 'proposed_skill' (you've drafted a new verb and " +
    "want it reviewed — pair this with a write to verbs/proposed/). Be specific in " +
    "the body: 'What I was doing', 'What I tried', 'What I'm asking for'.",
  input_schema: {
    type: 'object',
    properties: {
      kind: {
        type: 'string',
        enum: ['help', 'improvement', 'proposed_skill'],
        description:
          "Pick by the *ask*, not the observation. 'help' = work can't continue " +
          "without input. 'improvement' = file-and-forget. 'proposed_skill' = a " +
          'drafted verb is awaiting review.',
      },
      summary: {
        type: 'string',
        description:
          'One-line summary, used for the filename slug and the frontmatter summary field.',
      },
      body: {
        type: 'string',
        description:
          "Markdown body. Sections in order: 'What I was doing', 'What I tried', " +
          "'What I'm asking for'.",
      },
      urgency: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: "Defaults to 'normal'. 'high' only when truly blocking.",
      },
      agent_context: {
        type: 'string',
        description:
          'Which verb or context is escalating. Defaults to "chat" when omitted.',
      },
      proposed_skill_path: {
        type: 'string',
        description:
          "Path to the draft in verbs/proposed/ when kind='proposed_skill'. Omit " +
          'otherwise.',
      },
    },
    required: ['kind', 'summary', 'body'],
  },
};

export const PROPOSE_VERB_TOOL: Anthropic.Tool = {
  name: 'propose_verb',
  description:
    'Draft a new verb (playbook) into verbs/proposed/. Use this when you have ' +
    'noticed a recurring pattern that deserves its own playbook. The operator ' +
    'reviews the draft — you never move drafts to verbs/ yourself. Refuses if the ' +
    'slug already exists in verbs/ or verbs/proposed/.',
  input_schema: {
    type: 'object',
    properties: {
      slug: {
        type: 'string',
        description:
          'Lowercase letters, digits, hyphens; must start with a letter. The filename will be ' +
          '`verbs/proposed/<slug>.md`.',
      },
      description: {
        type: 'string',
        description:
          'One-line summary of what the verb does. Written into the file frontmatter.',
      },
      body: {
        type: 'string',
        description:
          'Full markdown for the proposed verb file. Should be runnable end-to-end: ' +
          'a person could open the file and execute the playbook.',
      },
    },
    required: ['slug', 'description', 'body'],
  },
};

export const APPEND_ENTRY_TOOL: Anthropic.Tool = {
  name: 'append_entry',
  description:
    'Append an entry to an operator-opened append-only YAML surface (e.g. ' +
    '`lib/research-strategies.yaml`). Use this for operational knowledge you ' +
    "discover during work — new heuristics, patterns, conventions, calibrations. " +
    "You can't edit or delete existing entries; the operator owns those. The " +
    'autonomy.yaml entry for the surface declares the root key (which list to ' +
    'append to), the unique field (often `id`), and the max_pending ceiling. ' +
    'If max_pending unreviewed entries have accumulated, the tool refuses — ' +
    "that's your signal to file an `improvement` escalation asking for compaction " +
    'instead of appending more.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Relative path to the append-only YAML surface, e.g. ' +
          '"lib/research-strategies.yaml". Must be listed in your role\'s ' +
          'lib/autonomy.yaml with mode: append-only.',
      },
      entry: {
        type: 'object',
        description:
          'The new entry to append. Shape depends on the surface — read the existing ' +
          'file structure first so your entry matches. Must include the field declared ' +
          'as unique_by (often "id") if the surface declares one. A `reviewed: false` ' +
          'marker is injected automatically so the operator can flip it to true on ' +
          'review without you needing to set it.',
      },
    },
    required: ['path', 'entry'],
  },
};

export const LOG_DECISION_TOOL: Anthropic.Tool = {
  name: 'log_decision',
  description:
    'Log a non-trivial decision to the role logs as an audit trail. Use when ' +
    'two-or-more reasonable options existed and you picked one — qualification ' +
    'verdicts, classifications, routing calls, voice shifts. A decision without a ' +
    'rationale is not worth logging; if you would write "obvious" as the rationale, ' +
    'skip it.',
  input_schema: {
    type: 'object',
    properties: {
      decision_type: {
        type: 'string',
        description:
          'Snake_case label for the kind of decision (e.g. "qualification_verdict", ' +
          '"angle_choice", "intake_classification", "routing", "other").',
      },
      chosen: {
        type: 'string',
        description: 'The option you took, in one line.',
      },
      rationale: {
        type: 'string',
        description: 'Why the chosen option beat the alternatives.',
      },
      considered: {
        type: 'array',
        items: { type: 'string' },
        description: 'Other options you weighed. Optional.',
      },
      confidence: {
        type: 'string',
        enum: ['low', 'medium', 'high'],
        description: 'How confident you are in the call. Optional.',
      },
      campaign: {
        type: 'string',
        description:
          'Optional campaign id. When set, the log lands under ' +
          'campaigns/<id>/logs/<date>.jsonl instead of logs/<date>.jsonl.',
      },
      extras: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Additional key=value pairs to merge into the log entry. Optional.',
      },
    },
    required: ['decision_type', 'chosen', 'rationale'],
  },
};

export const WRITE_OUTPUT_TOOL: Anthropic.Tool = {
  name: 'write_output',
  description:
    "Create a new file in your work-product surface (output/). The output " +
    "taxonomy has five types — pick by the *shape* of what you're producing: " +
    "`document` (long-form prose: brief, note, analysis), `draft` (outgoing " +
    'communication: email, Slack DM, letter), `record` (observation tied to ' +
    'an entity: an account read, a call summary, a meeting note), `plan` ' +
    '(multi-step intent with a checklist body: `- [ ]` items), `reference` ' +
    "(reusable knowledge: a heuristic, a recipe, a playbook excerpt). The " +
    "tool refuses if the file already exists — pick a different slug, or use " +
    'update_output_status to change an existing file\'s lifecycle stage. The ' +
    'file lives at `output/<type>/<slug>.md` (or, for records, ' +
    '`output/record/<entity_type>/<entity_id>/<slug>.md`).',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['document', 'draft', 'record', 'plan', 'reference'],
        description:
          "Pick by shape: prose=document, outgoing comms=draft, entity-tied " +
          'observation=record, multi-step intent with checklist=plan, ' +
          'reusable knowledge=reference.',
      },
      slug: {
        type: 'string',
        description:
          'Lowercase letters/digits/hyphens, starting alphanumeric. Used as the ' +
          'filename stem.',
      },
      body: {
        type: 'string',
        description:
          'Markdown body. For `plan` types, format the body as a checklist ' +
          'using `- [ ]` (open) and `- [x]` (done) items — the dashboard ' +
          'parses these to compute progress.',
      },
      status: {
        type: 'string',
        enum: ['draft', 'review', 'ready', 'sent', 'done', 'archived'],
        description:
          "Lifecycle stage. Defaults to 'draft'. Use 'review' when you want " +
          "operator eyes on it, 'ready' when it's complete and waiting for " +
          "action, 'sent' / 'done' when shipped, 'archived' when superseded.",
      },
      fields: {
        type: 'object',
        description:
          "Type-specific frontmatter fields. Required and optional fields by " +
          'type:\n' +
          '- document: required {title}; optional {audience}\n' +
          '- draft: required {}; optional {recipient, channel, subject} ' +
          '(channel ∈ email|slack|dm|letter|call|other)\n' +
          '- record: required {entity_type, entity_id, observed_at} — these ' +
          'drive the on-disk path (`output/record/<entity_type>/<entity_id>/' +
          '<slug>.md`); entity_type and entity_id must be slug-shaped\n' +
          '- plan: required {goal}; optional {owner}\n' +
          '- reference: required {topic}; optional {tags} (array of strings)',
      },
    },
    required: ['type', 'slug', 'body'],
  },
};

export const UPDATE_OUTPUT_STATUS_TOOL: Anthropic.Tool = {
  name: 'update_output_status',
  description:
    "Update the `status` field on an existing output file. Use this to " +
    'transition a draft email to "sent" after the operator confirms, mark a ' +
    'plan "done" once its checklist is fully checked, or "archive" a stale ' +
    "reference. The status enum is fixed framework-wide: draft, review, " +
    'ready, sent, done, archived. Refuses if the file doesn\'t exist — pick ' +
    'the right path or call write_output first.',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['document', 'draft', 'record', 'plan', 'reference'],
        description: 'Output type, same as the file\'s `type:` frontmatter.',
      },
      slug: {
        type: 'string',
        description: 'Slug of the existing file (filename stem).',
      },
      status: {
        type: 'string',
        enum: ['draft', 'review', 'ready', 'sent', 'done', 'archived'],
        description: 'The new lifecycle stage.',
      },
      entity_type: {
        type: 'string',
        description:
          'For `record` outputs only — the entity_type path segment of the ' +
          'existing file.',
      },
      entity_id: {
        type: 'string',
        description:
          'For `record` outputs only — the entity_id path segment of the ' +
          'existing file.',
      },
    },
    required: ['type', 'slug', 'status'],
  },
};

/**
 * The full toolset, in the order the model sees them. Memory first — most
 * common action; logging last — least conversational. `append_entry` slots
 * after the high-frequency growth tools and before logging. The output
 * tools sit between the role-growth tools and the audit tools — they're
 * work product, not introspection.
 */
export const CHAT_TOOLS: readonly Anthropic.Tool[] = [
  WRITE_MEMORY_TOOL,
  CREATE_ESCALATION_TOOL,
  PROPOSE_VERB_TOOL,
  APPEND_ENTRY_TOOL,
  WRITE_OUTPUT_TOOL,
  UPDATE_OUTPUT_STATUS_TOOL,
  LOG_DECISION_TOOL,
];
