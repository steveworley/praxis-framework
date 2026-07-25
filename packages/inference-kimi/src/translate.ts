import type {
  ContentBlock,
  InferenceResponse,
  Message,
  StopReason,
  ToolDef,
  Usage,
} from '@praxis-framework/inference';
import type OpenAI from 'openai';

/**
 * Map a neutral `Message` into the OpenAI chat message shape.
 *
 * The neutral schema models content as Anthropic-style blocks; we flatten
 * them into the OpenAI `content` format (string or array of parts). Tool
 * use and tool result blocks are mapped to OpenAI's `assistant`/`tool`
 * message types respectively.
 */
export function toOpenAIMessages(
  messages: Message[],
): OpenAI.Chat.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.ChatCompletionMessageParam[] = [];
  for (const msg of messages) {
    const converted = toOpenAIMessage(msg);
    if (Array.isArray(converted)) {
      out.push(...converted);
    } else {
      out.push(converted);
    }
  }
  return out;
}

function toOpenAIMessage(
  msg: Message,
): OpenAI.Chat.ChatCompletionMessageParam | OpenAI.Chat.ChatCompletionMessageParam[] {
  if (typeof msg.content === 'string') {
    if (msg.role === 'user') {
      return { role: 'user', content: msg.content };
    }
    return { role: 'assistant', content: msg.content };
  }

  // Separate tool_result blocks (which become individual `tool` messages)
  // from everything else (which goes into a single user/assistant message).
  const toolResults: Array<Extract<ContentBlock, { type: 'tool_result' }>> = [];
  const otherBlocks: ContentBlock[] = [];

  for (const block of msg.content) {
    if (block.type === 'tool_result') {
      toolResults.push(block);
    } else {
      otherBlocks.push(block);
    }
  }

  const result: OpenAI.Chat.ChatCompletionMessageParam[] = [];

  if (msg.role === 'assistant') {
    // Assistant messages can contain text and tool_use blocks.
    const textContent = otherBlocks
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[] = otherBlocks
      .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
      .map((b) => ({
        id: b.id,
        type: 'function' as const,
        function: {
          name: b.name,
          arguments: JSON.stringify(b.input),
        },
      }));

    const assistantMsg: OpenAI.Chat.ChatCompletionAssistantMessageParam = {
      role: 'assistant',
      content: textContent || null,
    };
    if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
    result.push(assistantMsg);
  } else {
    // User messages may contain text, image, and document blocks.
    const parts: OpenAI.Chat.ChatCompletionContentPart[] = [];
    for (const block of otherBlocks) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        parts.push({
          type: 'image_url',
          image_url: {
            url: `data:${block.source.media_type};base64,${block.source.data}`,
          },
        });
      } else if (block.type === 'document') {
        // Kimi does not have native document blocks; embed as base64 text.
        parts.push({
          type: 'text',
          text: `[document: ${block.name ?? 'file'}]\ndata:${block.source.media_type};base64,${block.source.data}`,
        });
      }
      // tool_use inside a user message is unusual; skip.
    }
    if (parts.length > 0) {
      result.push({ role: 'user', content: parts });
    }
  }

  // Each tool_result block becomes its own `tool` message.
  for (const tr of toolResults) {
    const content =
      typeof tr.content === 'string'
        ? tr.content
        : tr.content
            .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
            .map((b) => b.text)
            .join('');
    result.push({
      role: 'tool',
      tool_call_id: tr.tool_use_id,
      content,
    });
  }

  return result;
}

/**
 * Map a neutral `ToolDef` into the OpenAI function-calling shape.
 */
export function toOpenAITool(t: ToolDef): OpenAI.Chat.ChatCompletionTool {
  const fn: OpenAI.Chat.ChatCompletionTool['function'] = {
    name: t.name,
    parameters: t.input_schema as Record<string, unknown>,
  };
  if (t.description !== undefined) fn.description = t.description;
  return { type: 'function', function: fn };
}

/**
 * Convert an OpenAI (non-streaming) chat completion into a neutral
 * `InferenceResponse`.
 */
export function fromOpenAIResponse(
  res: OpenAI.Chat.ChatCompletion,
): InferenceResponse {
  const choice = res.choices[0];
  const content: ContentBlock[] = [];

  if (choice?.message.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  for (const tc of choice?.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments);
    } catch {
      input = tc.function.arguments;
    }
    content.push({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input,
    });
  }

  const stop_reason = mapFinishReason(choice?.finish_reason ?? null);

  const usage: Usage = {
    input_tokens: res.usage?.prompt_tokens ?? 0,
    output_tokens: res.usage?.completion_tokens ?? 0,
  };

  return {
    id: res.id,
    model: res.model,
    content,
    stop_reason,
    usage,
    raw: res,
  };
}

/**
 * Map an OpenAI finish_reason to a neutral StopReason.
 */
export function mapFinishReason(reason: string | null): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    case null:
    default:
      return 'end_turn';
  }
}

/**
 * Flatten a system string or Anthropic-style content blocks to a plain string
 * for the OpenAI system message.
 */
export function stringifySystem(
  system: string | ContentBlock[] | undefined,
): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('');
}
