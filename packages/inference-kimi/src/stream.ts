import type { StopReason, StreamEvent, Usage } from '@praxis-framework/inference';
import type OpenAI from 'openai';

import { mapFinishReason } from './translate.js';

/**
 * Translate an async iterable of OpenAI streaming chunks into neutral
 * `StreamEvent`s that the framework's `aggregateStream` can consume.
 *
 * OpenAI's streaming shape uses a single flat `choices[0].delta` per chunk
 * rather than Anthropic's indexed content-block events. We translate:
 *
 *  - First chunk with an `id` → `message_start`
 *  - Text deltas → `content_block_start` (once) + `content_block_delta`
 *  - Tool-call chunks → `content_block_start` (once per tool call) +
 *    `content_block_delta` (input_json_delta)
 *  - Final chunk (`finish_reason` set) → `content_block_stop` +
 *    `message_delta` + `message_stop`
 */
export async function* translateKimiStream(
  stream: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
): AsyncIterable<StreamEvent> {
  let messageStarted = false;
  let textBlockOpen = false;
  const TEXT_INDEX = 0;

  // Track open tool-call blocks keyed by OpenAI's per-call index.
  const toolCallIndexMap = new Map<number, number>(); // openai index → our block index
  let nextBlockIndex = 1; // 0 is reserved for the text block

  let finalUsage: Partial<Usage> | undefined;
  let finalStopReason: StopReason = 'end_turn';

  for await (const chunk of stream) {
    // Emit message_start once when we get the id.
    if (!messageStarted && chunk.id) {
      yield { type: 'message_start', id: chunk.id, model: chunk.model };
      messageStarted = true;
    }

    const choice = chunk.choices[0];
    if (!choice) {
      // Some providers emit a trailing usage-only chunk with no choices.
      if (chunk.usage) {
        finalUsage = {
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
        };
      }
      continue;
    }

    const delta = choice.delta;

    // Text content delta.
    if (delta.content) {
      if (!textBlockOpen) {
        yield {
          type: 'content_block_start',
          index: TEXT_INDEX,
          content_block: { type: 'text', text: '' },
        };
        textBlockOpen = true;
      }
      yield {
        type: 'content_block_delta',
        index: TEXT_INDEX,
        delta: { type: 'text_delta', text: delta.content },
      };
    }

    // Tool-call deltas.
    for (const tc of delta.tool_calls ?? []) {
      const oaiIndex = tc.index;

      if (!toolCallIndexMap.has(oaiIndex)) {
        // First chunk for this tool call: open a new block.
        if (textBlockOpen) {
          yield { type: 'content_block_stop', index: TEXT_INDEX };
          textBlockOpen = false;
        }
        const blockIndex = nextBlockIndex++;
        toolCallIndexMap.set(oaiIndex, blockIndex);
        yield {
          type: 'content_block_start',
          index: blockIndex,
          content_block: {
            type: 'tool_use',
            id: tc.id ?? `call_${oaiIndex}`,
            name: tc.function?.name ?? '',
            input: {},
          },
        };
      }

      const blockIndex = toolCallIndexMap.get(oaiIndex)!;

      // Accumulate partial JSON for the tool's arguments.
      if (tc.function?.arguments) {
        yield {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
        };
      }
    }

    // On the final chunk, close all open blocks and emit finish events.
    if (choice.finish_reason) {
      finalStopReason = mapFinishReason(choice.finish_reason);

      if (textBlockOpen) {
        yield { type: 'content_block_stop', index: TEXT_INDEX };
        textBlockOpen = false;
      }
      for (const blockIndex of toolCallIndexMap.values()) {
        yield { type: 'content_block_stop', index: blockIndex };
      }

      // Usage is provided on the top-level chunk, not on individual choices.
      if (chunk.usage) {
        finalUsage = {
          input_tokens: chunk.usage.prompt_tokens,
          output_tokens: chunk.usage.completion_tokens,
        };
      }
    }
  }

  // Emit the tail events after consuming the whole stream.
  const messageDelta: StreamEvent = {
    type: 'message_delta',
    delta: { stop_reason: finalStopReason },
  };
  if (finalUsage) messageDelta.usage = finalUsage;
  yield messageDelta;
  yield { type: 'message_stop' };
}
