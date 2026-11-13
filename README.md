<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/banner-night.svg">
    <img src="assets/banner-light.svg" alt="z1 sdk — everything is a module" width="100%">
  </picture>
</p>

<p align="center">
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-0b0b0b?style=flat-square"></a>
  <img alt="node" src="https://img.shields.io/badge/node-%E2%89%A524.9-0b0b0b?style=flat-square">
  <img alt="tests" src="https://img.shields.io/badge/tests-690-0b0b0b?style=flat-square">
  <img alt="status" src="https://img.shields.io/badge/status-early-0b0b0b?style=flat-square">
</p>

<p align="center">
  <strong>A modular agent SDK where everything is a node.</strong><br>
  Journaled graph runtime · branch memory · sandboxed modules · headless server · canvas
</p>

---

## What is z1?

z1 is an agent runtime built as a **graph of executable nodes** instead of a chat
loop. A model provider, a tool call, filesystem access, the prompt itself, and the
agent loop are all modules with declared inputs and outputs. A workflow is
assembled, not prompted.

The runtime is small and durable: every node execution is a checkpoint in an
append-only journal, a run can resume after a crash, a fork is a pointer rather
than a copy, and approvals are data on the node rather than a global switch.

```
chat / CLI / canvas
        │
        ▼
   graph template ──► executor ──► nodes
                                      │
                    journal ◄─────────┤
                    branches ◄────────┤
                    services ◄────────┘ (llm · fs · tools)
                                      │
                                      ▼
                               worker modules
```

## Why

- **Everything is a module.** Nodes, services, providers and graph templates are
  packages with manifests. Third-party code is installed with an explicit grant,
  runs in a child process, and reports every capability call back to the host.
- **A graph run is the primitive.** The agent loop is a graph you can read, diff
  and fork — not hidden control flow.
- **The prompt is a graph.** Sections are nodes, the stack is a node, and the
  rendered hash is journaled, so the prompt behind any branch is reproducible.
- **Memory is the run tree.** Ancestors, siblings and recent steps become a
  context envelope; a sibling records what was tried, not what is true.
- **Approvals are per node.** `auto`, `ask`, `deny`, with runtime escalation as a
  separate decision. A paused run is persisted, not a parked process.

## Architecture

```mermaid
%%{init: {'theme':'neutral'}}%%
flowchart LR
  U[chat · CLI · canvas] --> T[graph template]
  T --> G[graph document]
  G --> E[executor]
  E --> N[nodes]
  N --> J[(run journal)]
  N --> M[(branch memory)]
  N --> S[services<br/>llm · fs · tools]
  S --> W[worker module]
  W --> C[capability broker]
  C --> N
```

## Quick start

Requires **Node.js 24.9+** and **pnpm 11**.

```bash
pnpm install
pnpm -C z1 build                 # typecheck every package
pnpm -C z1 test                  # 690 tests

# run the agent loop with the deterministic mock model
pnpm z1 run --template agent.loop --message '[[tool:echo]] hi'

# real model (OpenAI-compatible endpoint)
export RIVER_API_KEY=...
pnpm z1 run --template agent.loop --live \
  --model river/deepseek-ai/DeepSeek-V4.1-Flash --message 'hello'

# canvas from one process
pnpm z1:canvas:build
pnpm z1 studio
```

## Commands

| Command | What it does |
| --- | --- |
| `z1 run --template <id>` | run a graph template without a graph file |
| `z1 run <graph.json>` | run a graph document |
| `z1 tree` / `z1 fork` | inspect the run tree, fork a branch |
| `z1 memory context <run>` | print the branch-tree context envelope |
| `z1 module propose/approve/list` | review and install executable modules |
| `z1 serve` | headless WebSocket server |
| `z1 studio` | server + built canvas in one process |

## The node contract

```ts
export const chat = defineNode({
  id: 'z1.llm.chat',
  version: '1.0.0',
  category: 'llm',
  config: z.object({ system: z.string().optional() }),
  inputs: [
    dataPort('messages', z.array(messageSchema)),
    flowPort('in', { required: false }),
  ],
  outputs: [dataPort('text', z.string()), flowPort('out')],
  async execute(ctx) {
    const result = await ctx.llm.chat(
      { model: ctx.config.model, messages: ctx.inputs.messages },
      (delta) => ctx.emit('text', delta.text),
    )
    return { text: result.message.content, out: true }
  },
})
```

Data ports are pulled from cache; flow edges order side effects. Cycles live only
inside `flow.loop`, `flow.map` or a subgraph. Nested runs carry an iteration label,
so a fork inside a loop replays only the earlier iterations.

## What is in the repo

| Path | Contents |
| --- | --- |
| `z1/packages/node`, `graph`, `runtime` | the kernel: contract, document, executor |
| `z1/packages/nodes` | core, flow, llm, tool and prompt nodes |
| `z1/packages/prompt` | sections, role presets, stacking and hashing |
| `z1/packages/journal` | SQLite run journal, forks, blobs |
| `z1/packages/memory`, `agent` | branch context and the agent loop as a graph |
| `z1/packages/module`, `node-host` | executable modules and the worker sandbox |
| `z1/packages/provider`, `template`, `bootstrap` | providers, templates, one runtime |
| `z1/packages/protocol`, `server` | JSON-RPC over WebSocket and the headless server |
| `z1/apps/cli`, `canvas` | the `z1` command and the React Flow canvas |
| `packages/*`, `apps/*` | the upstream DeepSeek Harness engine |

## Status

**Early.** The graph engine, journal, resume, approvals, forks, prompt nodes,
sandboxed modules, server and canvas are implemented and tested (690 tests). The
upstream engine still builds with its 10 gates.

Not in this repository:

- **concrete tools** — they live in a separate `z1-tools` package/repository; the
  SDK keeps only the tools service contract and brokered capabilities;
- **editor integration** — the canvas is a standalone app for now;
- **OS-level sandboxing** for untrusted modules — Node's permission model is not
  a network boundary, which is documented in `z1/packages/node-host/README.md`.

## Documentation

- [`z1/SPEC.md`](z1/SPEC.md) — node, graph, executor, journal and module contracts
- [`z1/TASKS.md`](z1/TASKS.md) — what was built, milestone by milestone
- [`z1/README.md`](z1/README.md) — service modules and the trust boundary
- [`NOTICE.md`](NOTICE.md) — fork provenance and what changed upstream

## Licence

MIT. The upstream copyright notice is kept in [LICENSE](LICENSE); third-party
components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and
the fork is described in [NOTICE.md](NOTICE.md).
