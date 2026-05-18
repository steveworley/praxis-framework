# @praxis-framework/inference

Provider-agnostic inference interface for [praxis-framework](https://github.com/steveworley/praxis-framework).

Praxis talks to language models through a small `InferenceProvider` interface
instead of a hard-wired SDK. This package defines that interface, ships an
Anthropic provider, and provides a streaming aggregator. First-party providers
for other backends (e.g. `@praxis-framework/inference-quantcloud`) implement the
same interface and are installed separately.

## Install

```sh
npm install @praxis-framework/inference
```

`@anthropic-ai/sdk` is a direct dependency — the Anthropic provider works out of
the box.

## Usage

```ts
import { AnthropicProvider } from '@praxis-framework/inference';

const provider = new AnthropicProvider(); // reads ANTHROPIC_API_KEY

const res = await provider.createMessage({
  model: 'claude-sonnet-4-6',
  system: 'You are concise.',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 256,
});
console.log(res.content); // ContentBlock[]
```

### Streaming

```ts
for await (const event of provider.streamMessage(req)) {
  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
    process.stdout.write(event.delta.text);
  }
}
```

`aggregateStream` folds a stream back into a single `InferenceResponse` — useful
when you want streaming's benefits without changing how you consume the result:

```ts
import { aggregateStream } from '@praxis-framework/inference';

const res = await aggregateStream(provider.streamMessage(req));
```

## The interface

```ts
interface InferenceProvider {
  readonly id: string;
  createMessage(req: InferenceRequest, signal?: AbortSignal): Promise<InferenceResponse>;
  streamMessage?(req: InferenceRequest, signal?: AbortSignal): AsyncIterable<StreamEvent>;
  resolveModel(logical: string): string;
}
```

Content blocks, tool definitions, and stream events are modelled on Anthropic's
shape, since that is what praxis's tool loop is built around. Providers for other
backends translate to and from this neutral shape. Errors are normalised to
`InferenceError` with a `code` (`auth`, `rate_limit`, `context`, `provider`,
`network`).

## License

MIT
