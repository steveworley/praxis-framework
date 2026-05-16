import type {
  ContentBlock,
  InferenceResponse,
  Message,
  StopReason,
  ToolDef,
  Usage,
} from '@praxis-framework/inference';

export interface QuantChatInferenceResponse {
  requestId: string;
  model: string;
  response: {
    role: 'assistant';
    content?: string;
    toolUse?: QuantToolUse | QuantToolUse[];
  };
  usage: Usage;
  sessionId?: string;
}

interface QuantToolUse {
  toolUseId: string;
  name: string;
  input: unknown;
}

export function fromQuantResponse(json: QuantChatInferenceResponse): InferenceResponse {
  const content: ContentBlock[] = [];
  if (json.response?.content) {
    content.push({ type: 'text', text: json.response.content });
  }
  const toolUses = Array.isArray(json.response?.toolUse)
    ? json.response.toolUse
    : json.response?.toolUse
      ? [json.response.toolUse]
      : [];
  for (const tu of toolUses) {
    content.push({ type: 'tool_use', id: tu.toolUseId, name: tu.name, input: tu.input });
  }
  const stop_reason: StopReason = toolUses.length > 0 ? 'tool_use' : 'end_turn';
  return {
    id: json.requestId,
    model: json.model,
    content,
    stop_reason,
    usage: json.usage,
    raw: json,
  };
}

// Bedrock Converse block shape — covers what Quant's API accepts.
export type BedrockBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: unknown } }
  | {
      toolResult: {
        toolUseId: string;
        content: BedrockBlock[];
        status: 'success' | 'error';
      };
    }
  | { image: { format: string; source: { bytes: string } } };

export function toBedrockBlock(b: ContentBlock): BedrockBlock {
  switch (b.type) {
    case 'text':
      return { text: b.text };
    case 'tool_use':
      return { toolUse: { toolUseId: b.id, name: b.name, input: b.input } };
    case 'tool_result':
      return {
        toolResult: {
          toolUseId: b.tool_use_id,
          content:
            typeof b.content === 'string'
              ? [{ text: b.content }]
              : b.content.map(toBedrockBlock),
          status: b.is_error ? 'error' : 'success',
        },
      };
    case 'image':
      return {
        image: {
          format: b.source.media_type.split('/')[1] ?? b.source.media_type,
          source: { bytes: b.source.data },
        },
      };
  }
}

export interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockBlock[];
}

export function toBedrockMessage(m: Message): BedrockMessage {
  const content: BedrockBlock[] =
    typeof m.content === 'string'
      ? [{ text: m.content }]
      : m.content.map(toBedrockBlock);
  return { role: m.role, content };
}

export interface BedrockToolSpec {
  toolSpec: {
    name: string;
    description?: string;
    inputSchema: { json: Record<string, unknown> };
  };
}

export function toBedrockToolSpec(t: ToolDef): BedrockToolSpec {
  const spec: BedrockToolSpec['toolSpec'] = {
    name: t.name,
    inputSchema: { json: t.input_schema },
  };
  if (t.description !== undefined) spec.description = t.description;
  return { toolSpec: spec };
}

export function stringifySystem(system: string | ContentBlock[] | undefined): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}
