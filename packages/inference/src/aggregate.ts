import type {
  ContentBlock,
  InferenceResponse,
  StopReason,
  StreamEvent,
  Usage,
} from './types.js';

/**
 * Consume a stream of events from `InferenceProvider.streamMessage` and assemble
 * an `InferenceResponse`. Useful when a caller wants the timeout-bypass of
 * streaming without changing its consumption model.
 *
 * Tool-use input arrives as a sequence of `input_json_delta` events whose
 * `partial_json` fragments concatenate into the full JSON payload, which is
 * parsed once the block closes.
 */
export async function aggregateStream(
  events: AsyncIterable<StreamEvent>,
): Promise<InferenceResponse> {
  let id = '';
  let model = '';
  let stopReason: StopReason = 'end_turn';
  let usage: Usage = { input_tokens: 0, output_tokens: 0 };

  // Per-index accumulators. A tool_use block may receive its input two ways:
  // streamed as `input_json_delta` fragments (Anthropic), or supplied complete
  // on `content_block_start` (Quant's translator). The accumulator tracks both.
  type ToolUseAccum = {
    __toolUseAccum: string;
    id: string;
    name: string;
    startInput: unknown;
  };
  const blocks: Array<ContentBlock | ToolUseAccum> = [];

  for await (const ev of events) {
    switch (ev.type) {
      case 'message_start':
        id = ev.id;
        model = ev.model;
        break;
      case 'content_block_start':
        if (ev.content_block.type === 'text') {
          blocks[ev.index] = { type: 'text', text: ev.content_block.text };
        } else {
          blocks[ev.index] = {
            __toolUseAccum: '',
            id: ev.content_block.id,
            name: ev.content_block.name,
            startInput: ev.content_block.input,
          };
        }
        break;
      case 'content_block_delta': {
        const current = blocks[ev.index];
        if (!current) break;
        if (ev.delta.type === 'text_delta' && 'type' in current && current.type === 'text') {
          current.text += ev.delta.text;
        } else if (ev.delta.type === 'input_json_delta' && '__toolUseAccum' in current) {
          current.__toolUseAccum += ev.delta.partial_json;
        }
        break;
      }
      case 'content_block_stop': {
        const current = blocks[ev.index];
        if (!current) break;
        if ('__toolUseAccum' in current) {
          // Streamed fragments win when present; otherwise keep the input
          // supplied on content_block_start.
          let input: unknown = current.startInput ?? {};
          if (current.__toolUseAccum.length > 0) {
            try {
              input = JSON.parse(current.__toolUseAccum);
            } catch {
              input = current.__toolUseAccum;
            }
          }
          blocks[ev.index] = {
            type: 'tool_use',
            id: current.id,
            name: current.name,
            input,
          };
        }
        break;
      }
      case 'message_delta':
        if (ev.delta.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage) usage = { ...usage, ...ev.usage } as Usage;
        break;
      case 'message_stop':
        break;
    }
  }

  // Filter out any leftover in-progress tool_use markers; emit only finalized blocks.
  const content: ContentBlock[] = blocks.filter(
    (b): b is ContentBlock => b !== undefined && !('__toolUseAccum' in b),
  );

  return { id, model, content, stop_reason: stopReason, usage };
}
