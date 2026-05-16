import type { StopReason, StreamEvent, Usage } from '@praxis-framework/inference';

export interface QuantSSEEvent {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Parse raw SSE stream chunks (string or Buffer) into discrete `{event, data}`
 * pairs. Data lines are JSON-parsed; non-JSON values are returned as-is.
 * Events that span chunk boundaries are reassembled.
 */
export async function* parseSSE(
  chunks: AsyncIterable<string | Buffer | Uint8Array>,
): AsyncIterable<QuantSSEEvent> {
  let buf = '';
  for await (const chunk of chunks) {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');

    let sepIdx: number;
    while ((sepIdx = buf.indexOf('\n\n')) !== -1) {
      const block = buf.slice(0, sepIdx);
      buf = buf.slice(sepIdx + 2);
      const parsed = parseSSEBlock(block);
      if (parsed) yield parsed;
    }
  }
  // Flush any trailing event (some servers omit the final \n\n).
  if (buf.length > 0) {
    const parsed = parseSSEBlock(buf);
    if (parsed) yield parsed;
  }
}

function parseSSEBlock(block: string): QuantSSEEvent | null {
  let event = 'message';
  const dataLines: string[] = [];
  for (const rawLine of block.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0 || line.startsWith(':')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const field = line.slice(0, colonIdx);
    const value = line.slice(colonIdx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  const dataStr = dataLines.join('\n');
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(dataStr) as Record<string, unknown>;
  } catch {
    data = { raw: dataStr };
  }
  return { event, data };
}

interface QuantStartData {
  requestId: string;
  model: string;
}
interface QuantContentData {
  delta: string;
}
interface QuantToolRequestData {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}
interface QuantDoneData {
  stopReason?: string;
  usage?: Partial<Usage> & {
    inputTokens?: number;
    outputTokens?: number;
  };
}

/**
 * Translate Quant Cloud's SSE event stream into neutral `StreamEvent`s.
 *
 * Quant's wire shape differs from Anthropic's: it emits high-level `content`
 * deltas (already-decoded text) and `tool_request` events with a complete
 * `input` payload (no `input_json_delta` streaming). Translation lifts those
 * into the indexed `content_block_*` events the aggregator expects.
 */
export async function* translateQuantStream(
  events: AsyncIterable<QuantSSEEvent>,
): AsyncIterable<StreamEvent> {
  let textBlockOpen = false;
  const TEXT_INDEX = 0;
  let nextToolIndex = 1;
  let lastUsage: Partial<Usage> | undefined;
  let lastStopReason: StopReason = 'end_turn';

  for await (const ev of events) {
    switch (ev.event) {
      case 'start': {
        const d = ev.data as unknown as QuantStartData;
        yield { type: 'message_start', id: d.requestId, model: d.model };
        break;
      }
      case 'content': {
        const d = ev.data as unknown as QuantContentData;
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
          delta: { type: 'text_delta', text: d.delta },
        };
        break;
      }
      case 'tool_request': {
        const d = ev.data as unknown as QuantToolRequestData;
        if (textBlockOpen) {
          yield { type: 'content_block_stop', index: TEXT_INDEX };
          textBlockOpen = false;
        }
        const idx = nextToolIndex++;
        yield {
          type: 'content_block_start',
          index: idx,
          content_block: { type: 'tool_use', id: d.toolUseId, name: d.name, input: d.input },
        };
        yield { type: 'content_block_stop', index: idx };
        break;
      }
      case 'done': {
        const d = ev.data as unknown as QuantDoneData;
        if (textBlockOpen) {
          yield { type: 'content_block_stop', index: TEXT_INDEX };
          textBlockOpen = false;
        }
        lastStopReason = mapStopReason(d.stopReason);
        lastUsage = normaliseUsage(d.usage);
        const delta: StreamEvent = {
          type: 'message_delta',
          delta: { stop_reason: lastStopReason },
        };
        if (lastUsage) delta.usage = lastUsage;
        yield delta;
        yield { type: 'message_stop' };
        break;
      }
      // Ignore tool_start/tool_complete (cloud auto-execute results); not part of the
      // Anthropic content-block flow that the aggregator consumes.
      default:
        break;
    }
  }
}

function mapStopReason(s: string | undefined): StopReason {
  switch (s) {
    case 'tool_request':
    case 'tool_use':
      return 'tool_use';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'end_turn':
    case undefined:
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

function normaliseUsage(u: QuantDoneData['usage'] | undefined): Partial<Usage> | undefined {
  if (!u) return undefined;
  // Accept both snake_case and camelCase from the wire.
  const input_tokens = u.input_tokens ?? u.inputTokens;
  const output_tokens = u.output_tokens ?? u.outputTokens;
  if (input_tokens === undefined && output_tokens === undefined) return undefined;
  const out: Partial<Usage> = {};
  if (input_tokens !== undefined) out.input_tokens = input_tokens;
  if (output_tokens !== undefined) out.output_tokens = output_tokens;
  return out;
}
