<div align="center">

# z1 sdk

**A modular agent SDK. Everything is a module; a module is a node.**

</div>

z1 sdk is the runtime behind the z1 agent: a graph of typed nodes instead of a
chat loop. Model providers, tools, filesystem access, sandboxes and the loop
itself are modules with declared inputs and outputs, so a workflow is assembled
rather than prompted.

Built on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
engine (MIT), which contributes the plugin runtime, sessions, providers, tools
and sandboxes. This repository removes the product surfaces — web UI pieces not
needed by the SDK, documentation site, benchmarks, desktop packaging — and keeps
the engine and the SDK composition.

## Status

**Early.** The engine builds and its gates pass on this tree. The module
contract, the graph executor and the node canvas are being designed; nothing in
this repository implements them yet.

## What is in here

| Path | Contents |
| --- | --- |
| `packages/core` | the runtime: sessions, models, tools, permissions |
| `packages/llm` | model providers |
| `packages/session*` | session log, projections, persistence |
| `packages/tool-*`, `packages/tools` | tool definitions and execution |
| `packages/sandbox*`, `packages/fs*`, `packages/shell*` | capability boundaries |
| `packages/mcp`, `packages/lsp`, `packages/skill` | integrations |
| `packages/sdk` | the SDK composition (`sdk-app`, JSON-RPC server, client) |
| `packages/bundle` | profile compositions: `base`, `headless`, `sdk-app`, `sdk-minimal` |
| `packages/client` | React UI packages (kept for the future canvas) |
| `apps/cli` | the executable |
| `apps/web` | the shipped web client |
| `native`, `vendor`, `patches` | native addon, vendored Cordis packages, dependency patches |

## Build

Requires **Node.js 24.9+** and **pnpm 11**.

```bash
pnpm install
pnpm run build        # typecheck, bundle host and client, web build — 10 gates
```

Run the agent:

```bash
pnpm dsh web --no-open --port 3080     # web UI, prints a token URL
pnpm dsh <prompt>                      # one-shot, needs a provider key
```

## Providers

Bring your own key. A provider is configured with an endpoint, a protocol
(`openai-completions`, `openai-responses`, `anthropic-messages`,
`google-generative-ai`) and a credential reference, or with an environment
variable such as `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.

## Licence

MIT. The upstream copyright notice is kept in [LICENSE](LICENSE); third-party
components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and
what this fork changed is recorded in [NOTICE.md](NOTICE.md).
