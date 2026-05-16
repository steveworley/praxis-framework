# @praxis-framework/inference-quantcloud

Quant Cloud inference provider for [praxis-framework](https://github.com/steveworley/praxis-framework).

Implements the `InferenceProvider` interface from `@praxis-framework/inference`,
routing inference through [QuantCDN](https://www.quantcdn.io)'s AI API — model
routing, streaming, and spend tracking — instead of calling a model vendor
directly.

## Install

```sh
npm install @praxis-framework/inference-quantcloud @praxis-framework/inference
```

`@praxis-framework/inference` is a peer dependency.

## Configuration

| Env var | Purpose |
| --- | --- |
| `QUANT_API_TOKEN` | Bearer token (required) |
| `QUANT_ORGANISATION` | Organisation id (required) |
| `QUANT_BASE_URL` | API base URL — defaults to `https://dashboard.quantcdn.io` (public). Use `https://dash.quantgov.cloud` for the AU/gov endpoint. A trailing `/api/v3` is accepted and normalised. |
| `QUANT_PREFER_STREAMING` | Set `false` to force the buffered endpoint |

## Usage

```ts
import { QuantCloudProvider } from '@praxis-framework/inference-quantcloud';

const provider = new QuantCloudProvider(); // reads QUANT_* env vars

const res = await provider.createMessage({
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'Hello' }],
  max_tokens: 256,
});
```

In praxis, select it with `PRAXIS_INFERENCE_PROVIDER=quantcloud`.

## Behaviour

- **Streaming by default.** `createMessage` consumes the streaming endpoint and
  aggregates events into a response. `streamMessage` exposes the raw event
  stream for token-by-token UX. Set `preferStreaming: false` (or
  `QUANT_PREFER_STREAMING=false`) to use the buffered `chatInference` endpoint —
  only needed when relying on Quant's server-side `autoExecute` of cloud tools.
- **Model names.** Common Anthropic-style names (`claude-sonnet-4-6`, etc.) are
  mapped to the Bedrock-style ids Quant's catalogue expects. Already-Quant-style
  ids (`anthropic.*`, `amazon.*`) and unknown ids pass through untouched. Pass
  `defaultModelId` to pin a specific id regardless of the request.
- **Translation.** Anthropic-shape content blocks and tool definitions are
  translated to/from the Bedrock Converse shape Quant's API uses.

## License

MIT
