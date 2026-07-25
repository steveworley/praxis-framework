# @praxis-framework/inference-kimi

Kimi (Moonshot AI) inference provider for [praxis-framework](https://github.com/steveworley/praxis-framework).

Implements the `InferenceProvider` interface from `@praxis-framework/inference`,
routing inference through [Kimi's OpenAI-compatible API](https://platform.moonshot.cn/docs/api/chat)
instead of calling Anthropic directly.

## Install

```sh
npm install @praxis-framework/inference-kimi @praxis-framework/inference
```

`@praxis-framework/inference` is a peer dependency.

## Configuration

| Env var | Purpose |
| --- | --- |
| `KIMI_API_KEY` | Moonshot API key — **required** unless passed via `apiKey` option |
| `KIMI_BASE_URL` | API base URL — defaults to `https://api.moonshot.cn/v1` |

## Usage

```ts
import { KimiProvider } from '@praxis-framework/inference-kimi';

const provider = new KimiProvider(); // reads KIMI_API_KEY from env

const res = await provider.createMessage({
  model: 'moonshot-v1-8k',
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

`aggregateStream` (from `@praxis-framework/inference`) folds a stream back into a
single `InferenceResponse`:

```ts
import { aggregateStream } from '@praxis-framework/inference';

const res = await aggregateStream(provider.streamMessage(req));
```

## Constructor options

```ts
new KimiProvider({
  apiKey?: string,       // falls back to KIMI_API_KEY
  baseURL?: string,      // falls back to KIMI_BASE_URL → https://api.moonshot.cn/v1
  defaultModel?: string, // pin a specific model id regardless of the request
  client?: OpenAI,       // inject a pre-built OpenAI client (for testing)
})
```

## Model names

Praxis passes logical model names to `createMessage`. The provider maps several
convenience aliases to canonical Moonshot model ids:

| Logical name / alias | Resolved Moonshot id |
| --- | --- |
| `moonshot-v1-8k` | `moonshot-v1-8k` |
| `moonshot-v1-32k` | `moonshot-v1-32k` |
| `moonshot-v1-128k` | `moonshot-v1-128k` |
| `kimi-8k` | `moonshot-v1-8k` |
| `kimi-32k` | `moonshot-v1-32k` |
| `kimi-128k` | `moonshot-v1-128k` |

Any id not in the table is passed through unchanged, so newer model ids work
without a package update. Pass `defaultModel` to pin a specific id regardless of
the request.

## API surface assumptions

Kimi's API is OpenAI-compatible. The provider uses the `openai` npm package
pointed at `https://api.moonshot.cn/v1` (or a custom `KIMI_BASE_URL`) and
translates praxis's Anthropic-shaped content blocks:

- **Messages** — `tool_use` blocks become OpenAI `tool_calls`; `tool_result`
  blocks become standalone `tool` messages.
- **Streaming** — OpenAI SSE chunks are translated to praxis's indexed
  `content_block_*` events so the standard `aggregateStream` helper works.
- **Errors** — OpenAI SDK errors are normalised to `InferenceError` with
  `code` mapped from HTTP status: `401`/`403` → `auth`,
  `429` → `rate_limit`, all others → `provider`.
- **Attachments** — images (PNG, JPEG, GIF, WebP) are sent as `image_url`
  parts; native document blocks are not supported by the Kimi API and are
  embedded as base64 text.

## License

MIT
