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

/**
 * The full toolset, in the order the model sees them. Memory first — most
 * common action; logging last — least conversational.
 */
export const CHAT_TOOLS: readonly Anthropic.Tool[] = [
  WRITE_MEMORY_TOOL,
  CREATE_ESCALATION_TOOL,
  PROPOSE_VERB_TOOL,
  LOG_DECISION_TOOL,
];
