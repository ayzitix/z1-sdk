<div align="center">

# z1 sdk

**A modular agent SDK. Everything is a module; a module is a node.**

</div>

z1 is a node-graph agent SDK. Model providers, tools, filesystem access and the
agent loop itself are executable nodes with typed ports; a workflow is assembled
on a canvas instead of prompted into a chat window. Runs are journaled, approval
is per node, and the history is a tree you can fork.

Built on the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
engine (MIT), which contributes the plugin runtime, sessions, providers, tools
and sandboxes. The node-graph layer lives in [`z1/`](z1/SPEC.md) and does not
modify the engine.

## Status

**Working prototype.** The graph engine, durable journal, resume, approvals,
branch forks, sandboxed executable modules with an approval panel, the agent
loop as a real graph, branch-tree memory, a headless server, real
OpenAI-compatible models and a browser canvas are implemented and tested
(651 tests). Not implemented yet: editor integration and OS-level sandboxing
for untrusted modules.

## Quick start

Requires **Node.js 24.9+** and **pnpm 11**.

```bash
pnpm install
pnpm z1:build                 # typecheck every z1 package
pnpm z1:test                  # 220 tests

# run a graph with the deterministic mock model
pnpm z1 run z1/examples/hello.graph.json --input '{"name":"world"}'

# run it with a real model (OpenAI-compatible endpoint)
export RIVER_API_KEY=...
pnpm z1 run z1/examples/agent.live.graph.json --live --input '"hello"'

# inspect the run tree and fork a branch
pnpm z1 tree
pnpm z1 fork <runId> --at chat
pnpm z1 run <graph> --resume <forkedRunId>

# the agent loop as a graph (tool call, loop, memory)
pnpm z1 run z1/examples/agent.loop.graph.json --message '[[tool:echo]] hi'

# or run a template without a graph file
pnpm z1 run --template agent.loop --message '[[tool:echo]] hi'
pnpm z1 template list

# executable modules: propose, review, approve, then run
pnpm z1 module propose z1/examples/modules/echo
pnpm z1 module approve com.example.echo
pnpm z1 module list
pnpm z1 memory context <runId>
```

Commands: `z1 list`, `z1 validate`, `z1 run`, `z1 tree`, `z1 fork`, `z1 serve`.
Run state lives in `.z1/runs.db` (SQLite).

### Canvas

```bash
pnpm z1 studio               # server + built canvas, one command, opens the browser
```

`z1 studio` serves the canvas and the WebSocket API from one process and prints
the URL with the token. Graph documents are stored server-side
(`.z1/graphs/<id>.json`) with versions; the canvas autosaves, detects write
conflicts, and can create empty or hello graphs. The inspector shows the last
run of the selected node (status, duration, outputs, prompt hash, fork), and the
runs panel is a branch tree with a per-run timeline.

For development with hot reload:

```bash
pnpm z1 serve --json          # prints {"url":"ws://…","token":"…"}
pnpm z1:canvas                # Vite dev server on :5173
```

Open the canvas, paste the URL and token (or pass `?url=…&token=…`), then
connect, load a graph JSON, press Run. Approvals appear as a dialog; the runs
panel lists branches and forks; the modules panel proposes, approves and rolls
back executable modules and shows the audit log.

## How it works

A **module** is an npm package. It contributes **nodes** (typed data inputs and
outputs, plus explicit flow edges) and may contribute services. A module can
also be **service-only** (`nodes: []`): it declares an ambient service such as
`llm`, `tools`, `fs`, `artifacts` or `memory`, and once approved the runtime
uses it instead of the built-in default. Services default to `mode: "worker"`
(sandboxed child process, same capability broker as nodes); `mode: "host"` with
`trusted: true` runs them in-process.

Each active module gets **one child process**, shared by its nodes and its
worker services: a node and the module's `llm` service report the same
`process.pid`, and that child is reused by every later run of the runtime. A
crashed child is respawned lazily by the next call, so one failed run does not
poison later ones. A per-run switch (`useServiceModules`, CLI
`--no-service-modules`) excludes services for that run only; the node modules
keep running, and the next run can use the service again.
 A node is real code:

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

Execution is a hybrid scheduler: data ports are pulled from cache, flow edges
order side effects. Cycles live only inside `flow.loop`, `flow.map` or a
subgraph. Every node execution is a checkpoint in an append-only SQLite journal;
a run resumes from it, and `fork` is a pointer, not a copy.

Approval is data on the node instance — `auto`, `ask` or `deny` — with runtime
escalation as a separate decision. The server sends an `approval/request` over
JSON-RPC and the canvas answers it. A paused run is persisted as
`run.suspended`, not a parked process.

The branch tree is the long-term memory: every node completion is a node in the
tree, non-taken siblings are recorded as history, summaries are regenerated
lazily with provenance back to the node or artifact, and `memory.context`
injects an ancestor/sibling/recent envelope into the agent graph.

The system prompt is a graph too. `prompt.section` nodes carry one section each
(identity, success, graph contract, autonomy, loop, editing, failure, memory,
communication, output, role), `core.concat` collects them and `prompt.stack`
orders, deduplicates, budget-cuts and hashes the result; `llm.chat.system`
consumes the text. Edit one section on the canvas, rewire the stack, or replace
the whole thing with `prompt.text` — the run records the stack hash, so the
prompt that produced a branch is reproducible.

Modules are reviewed before they run. A module is an npm-shaped directory with a
manifest (id, version, integrity, declared ports and capabilities) and a
dependency-free ESM entry. `z1 module propose` copies it to a proposal store;
`z1 module approve` installs an immutable version, records a grant and an audit
entry. **The grant is the authority**: it may approve less than the manifest
requests, and `z1 module list` shows the granted capabilities and services (the
manifest is only the request). `z1 run --no-modules` removes the whole module
layer — node modules and services, host and worker alike — from that run. A
worker service that asks for approval is routed to the run that started the
call, so an allow or reject reaches the same connection and no other run can
answer it. At run time each module executes in a child process under Node's
permission model, and every `ctx.*` capability call is checked against the
manifest. Node's permission model does not block direct sockets, so untrusted
modules still need an OS-level sandbox — this is documented in
`z1/packages/node-host/README.md`.

## Repository

| Path | Contents |
| --- | --- |
| `z1/packages/node` | node contract, ports, capabilities, autonomy, registry |
| `z1/packages/graph` | graph document, validation, digest |
| `z1/packages/runtime` | executor, cache, approvals, resume, nested runs |
| `z1/packages/nodes` | core, flow, subgraph, llm and tool nodes |
| `z1/packages/journal` | SQLite journal, forks, content-addressed blobs |
| `z1/packages/module` | manifest, capabilities, integrity, store, grants, audit |
| `z1/packages/node-host` | sandboxed child-process worker and capability RPC |
| `z1/packages/memory` | branch-tree queries and context envelopes |
| `z1/packages/agent` | the default agent loop as a graph |
| `z1/packages/prompt` | prompt sections, role presets, stacking and hashing |
| `z1/packages/protocol` | JSON-RPC 2.0 transport and method map |
| `z1/packages/bootstrap` | one runtime composition from `z1.config.json` |
| `z1/packages/provider` | provider registry and routing |
| `z1/packages/template` | graph templates: builder and static, loaded by id |
| `z1/packages/server` | headless WebSocket server |
| `z1/packages/provider-openai` | OpenAI-compatible streaming provider |
| `z1/apps/cli` | the `z1` executable |
| `z1/apps/canvas` | React Flow canvas |
| `z1/SPEC.md`, `z1/TASKS.md` | contract and milestone board |
| `packages/*`, `apps/*` | the upstream DeepSeek Harness engine |
| `native`, `vendor`, `patches` | native addon, vendored Cordis packages, patches |

The upstream engine still builds with its 10 gates (`pnpm run build`); the z1
layer is a separate workspace group with its own tsconfig and test runner.

## Configuration

`z1.config.json` (optional, in the working directory) configures one runtime for
the CLI and the server:

```json
{
  "dbPath": ".z1/runs.db",
  "graphsPath": ".z1/graphs",
  "modulesPath": "~/.z1/modules",
  "templatesPath": ".z1/templates",
  "live": false,
  "useModules": true,
  "useMemory": true,
  "providers": [
    { "id": "river", "envKey": "RIVER_API_KEY", "baseURL": "https://api.river.ai/v1" },
    { "id": "local", "envKey": "LOCAL_API_KEY", "baseURL": "http://127.0.0.1:11434/v1" }
  ]
}
```

Precedence: CLI flags > environment (`Z1_DB`, `Z1_GRAPHS_DIR`,
`Z1_MODULES_DIR`, `Z1_TEMPLATES_DIR`, `Z1_LIVE`, `Z1_PROVIDERS`) > file > defaults. A provider is
data: add one by config, not by editing the CLI. See
[`z1.config.example.json`](z1.config.example.json). Static graph templates are
`*.json` files under `templatesPath`, listed by `z1 template list` and run with
`z1 run --template <id>`.

## Providers

Bring your own key. The built-in OpenAI-compatible provider talks to any
`/chat/completions` endpoint — River, OpenAI, or a local server — with streaming
text, reasoning deltas and tool calls. Configure it with env vars:

```bash
export RIVER_API_KEY=...            # provider "river" in the graph
export Z1_OPENAI_BASE_URL=...       # optional endpoint override
pnpm z1 run <graph> --live
```

Rate limits are retried with exponential backoff and `retry-after`;
`Z1_LLM_RETRY_ATTEMPTS`, `Z1_LLM_RETRY_BASE_MS` and `Z1_LLM_RETRY_MAX_MS` tune
the budget. A live River turn was verified end to end: the model returned a tool
call, the tool ran, and a second model round produced the final answer.

## Licence

MIT. The upstream copyright notice is kept in [LICENSE](LICENSE); third-party
components are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and
what this fork changed is recorded in [NOTICE.md](NOTICE.md).
