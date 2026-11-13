# z1 SDK — implementation specification (M0)

Authoritative contract for the node-graph SDK. Every implementation subagent must
follow this file. If something here is wrong, report it instead of silently
diverging.

## 1. Decisions already made

1. The SDK's top-level primitive is a **graph run**, not a chat turn. The agent
   loop is a built-in subgraph made of the same nodes.
2. A **module** is an npm package. It contributes **nodes** (typed ports) and may
   contribute **services** (ambient capabilities). A provider module shows up on
   the canvas as a node (`llm.model`) that yields a serializable `ModelHandle`.
3. Two edge kinds: `data` (typed value, pulled, cached) and `flow` (control,
   ordered, side effects).
4. Cycles exist only inside `flow.loop` / `flow.map` / `graph.subgraph`
   (nested graphs), never as free edges.
5. Autonomy is per **node instance**: `auto | ask | deny`, with runtime
   escalation as a separate approval.
6. Every node execution is checkpointed; branches are forks of a run.
7. Node code runs behind a host boundary (worker in a later milestone). Core
   nodes and the executor run in the host.
8. `@z1/*` packages live in `z1/`, outside the upstream `packages/*` workspace
   machinery. Upstream `pnpm run build` (10 gates) must stay untouched and green.

## 2. Repository layout

```
z1/
  package.json              # private workspace root; scripts build/test/z1
  tsconfig.base.json        # strict TS, paths for @z1/*
  tsconfig.json             # solution file, references every package
  vitest.config.ts
  SPEC.md
  TASKS.md
  packages/
    graph/                  # @z1/graph
    node/                   # @z1/node
    runtime/                # @z1/runtime
    nodes/                  # @z1/nodes
    journal/                # @z1/journal (M1)
    protocol/               # @z1/protocol (M2)
    server/                 # @z1/server (M2)
  apps/
    cli/                    # @z1/cli, bin `z1`
  examples/
    hello.graph.json
    agent.graph.json
```

Upstream `pnpm-workspace.yaml` gets `z1/packages/*` and `z1/apps/*`.
Upstream root `package.json` gets `z1:build`, `z1:test`, `z1` scripts.

## 3. TypeScript conventions

- ESM only, `"type": "module"`.
- Source imports use explicit `.ts` extensions (`./x.ts`), as upstream does.
  `rewriteRelativeImportExtensions: true` is on.
- Cross-package imports use the package name (`@z1/graph`), resolved by
  `paths` in `z1/tsconfig.base.json` for typecheck and by pnpm links at runtime.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noUnusedLocals`, `noUnusedParameters`, `noImplicitOverride`.
- Each package: `src/index.ts`, optional `src/types.ts`, `tests/*.spec.ts`.
- Build output: `lib/` with `.js` + `.d.ts` next to each other.
- Tests: vitest. No coverage threshold for M0 (add later).
- No `any` in public API. `unknown` + zod parsing at boundaries.
- Comments: explain *why*, never restate the type. English.

## 4. `@z1/node` — public node contract

```ts
import type { z } from 'zod'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type PortKind = 'data' | 'flow'
export type StreamMode = 'value' | 'stream'

export type PortSpec =
  | {
      kind: 'data'
      id: string
      title?: string
      description?: string
      /** Zod schema for the wire value; also exported as JSON Schema for the UI. */
      schema: z.ZodType
      required?: boolean          // default true
      mode?: StreamMode           // default 'value'
      /** Readiness: all connected inputs must resolve, or any one of them. */
      waitFor?: 'all' | 'any'     // default 'all'
    }
  | { kind: 'flow'; id: string; title?: string; description?: string }

export type AutonomyMode = 'auto' | 'ask' | 'deny'

export interface AutonomyPolicy {
  mode: AutonomyMode
  reason?: string
  timeoutMs?: number
  onTimeout?: 'deny' | 'approve'
}

export type Capability =
  | { kind: 'fs.read'; paths: readonly string[] }
  | { kind: 'fs.write'; paths: readonly string[] }
  | { kind: 'net'; hosts: readonly string[]; methods?: readonly string[] }
  | { kind: 'process.spawn'; commands?: readonly string[] }
  | { kind: 'spend'; currency: string; perCall?: number; perRun?: number }
  | { kind: 'secrets'; refs: readonly string[] }

export interface ModelHandle {
  provider: string
  model: string
  credentialRef?: string
  params?: Record<string, Json>
}

export interface ToolCall { id: string; name: string; arguments: Json }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  toolCallId?: string
  toolCalls?: ToolCall[]
}

export interface ToolSchema {
  name: string
  description?: string
  parameters: Record<string, Json>   // JSON Schema
}

export interface ChatRequest {
  model: ModelHandle
  messages: readonly ChatMessage[]
  tools?: readonly ToolSchema[]
  temperature?: number
  maxTokens?: number
}

export interface ChatUsage { inputTokens: number; outputTokens: number }

export interface ChatResult {
  message: ChatMessage
  toolCalls: readonly ToolCall[]
  usage?: ChatUsage
  stopReason: 'stop' | 'tool_calls' | 'length' | 'error'
}

export type ChatDelta =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_call'; index: number; id?: string; name?: string; argumentsDelta?: string }

export interface ApprovalRequest {
  action: string                 // 'tool.call' | 'fs.write' | 'net.request' | 'spend' | custom
  target?: string
  reason?: string
  preview?: Json
  proposalHash?: string
}

export type ApprovalDecision = 'allowed-once' | 'rejected' | 'cancelled'

export interface SubgraphRunOptions {
  graph: unknown                 // GraphDocument; typed in @z1/runtime to avoid a cycle
  input?: Json
}

export interface NodeContext<C = unknown> {
  readonly runId: string
  readonly nodeId: string
  /** Hierarchical execution path, e.g. `loop1/0/chat`. */
  readonly path: string
  readonly attempt: number
  readonly input: Json
  readonly config: C
  readonly signal: AbortSignal
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string, data?: Json): void
  /** Out-of-band stream chunk for a data output port. Never journaled per chunk. */
  emit(port: string, chunk: Json): void
  llm: { chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult> }
  tools: {
    call(name: string, args: Json): Promise<Json>
    list(): Promise<readonly ToolSchema[]>
  }
  fs: {
    read(path: string): Promise<string>
    write(path: string, data: string): Promise<void>
  }
  artifacts: {
    put(data: Uint8Array, mime: string): Promise<string>
    get(hash: string): Promise<Uint8Array>
  }
  approval: { request(request: ApprovalRequest): Promise<ApprovalDecision> }
  /** Run a nested graph (loop body, subgraph node). Shares services and run id. */
  runSubgraph(options: SubgraphRunOptions): Promise<{ outputs: Record<string, Json> }>
}

export type NodeOutputs = Record<string, Json | undefined>

export interface NodeDefinition<C = unknown> {
  readonly id: string
  readonly version: string
  readonly title: string
  readonly description?: string
  readonly category: string
  readonly config: z.ZodType<C>
  readonly inputs: readonly PortSpec[]
  readonly outputs: readonly PortSpec[]
  readonly capabilities?: readonly Capability[]
  readonly autonomy?: AutonomyPolicy
  readonly timeoutMs?: number
  readonly retry?: { attempts: number; backoffMs: number }
  /** false disables the per-run output cache for this node (default true). */
  readonly cacheable?: boolean
  execute(ctx: NodeContext<C>): Promise<NodeOutputs>
}

export function defineNode<C>(definition: NodeDefinition<C>): NodeDefinition<C>
export class NodeRegistry {
  register(definition: NodeDefinition): void
  get(id: string, version?: string): NodeDefinition | undefined
  list(): readonly NodeDefinition[]
  has(id: string, version?: string): boolean
}
```

`NodeRegistry.get` matches an exact version string. If `version` is omitted, it
returns the single registered version and throws if the id has several.

## 5. `@z1/graph` — graph document

```ts
export interface GraphNode {
  id: string
  type: string                   // NodeDefinition.id
  version: string                // exact version for M0
  config: Json
  autonomy?: AutonomyPolicy
  position: { x: number; y: number }
  label?: string
}

export interface GraphEdge {
  id: string
  kind: 'data' | 'flow'
  from: { node: string; port: string }
  to: { node: string; port: string }
}

export interface GraphDocument {
  schemaVersion: 1
  id: string
  title?: string
  nodes: readonly GraphNode[]
  edges: readonly GraphEdge[]
  metadata?: Record<string, Json>
}

export function parseGraph(input: unknown): GraphDocument
export function validateGraph(
  graph: GraphDocument,
  registry: NodeRegistry,
): readonly ValidationIssue[]

export interface ValidationIssue {
  code:
    | 'duplicate-node-id'
    | 'unknown-node-type'
    | 'unknown-port'
    | 'port-kind-mismatch'
    | 'port-type-mismatch'
    | 'missing-required-input'
    | 'dangling-edge'
    | 'self-edge'
    | 'flow-cycle'
    | 'invalid-config'
    | 'duplicate-edge-id'
    | 'duplicate-data-edge'
  message: string
  nodeId?: string
  edgeId?: string
}

/**
 * Stable hash of a graph's semantic content: id, type, version, config and
 * autonomy, plus edges. Display-only fields (`position`, `label`) do not count.
 */
export function graphDigest(graph: GraphDocument): string
```

Rules:

- Every `type` must resolve in the registry at that exact `version`.
- Edge endpoints must exist and the port kind must match the edge kind.
- For `data` edges between ports of different schemas: compatible when both
  JSON Schemas have the same `type` (`string|number|boolean|object|array|null`)
  or either side is an unconstrained schema. Do not attempt deep structural
  assignability in M0.
- Required data inputs must be connected, unless the port is fed by a root node
  the executor seeds (`core.input`).
- Duplicate incoming data edges into the same port are an error
  (`duplicate-data-edge`).
- Free cycles in `flow` edges are an error. Nested graphs are validated
  recursively when they appear in node config; the nested graph is stored under
  `config.graph` (or `config.body`) and is opaque to the top-level validator.

## 6. `@z1/runtime` — executor

```ts
export interface LlmService {
  chat(request: ChatRequest, onDelta?: (delta: ChatDelta) => void): Promise<ChatResult>
}
export interface ToolService {
  call(name: string, args: Json): Promise<Json>
  list(): Promise<readonly ToolSchema[]>
}
export interface FsService {
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
}
export interface ArtifactService {
  put(data: Uint8Array, mime: string): Promise<string>
  get(hash: string): Promise<Uint8Array>
}
export interface ApprovalService {
  request(request: ApprovalRequest, context: { runId: string; nodeId: string }): Promise<ApprovalDecision>
}

export interface RuntimeServices {
  llm: LlmService
  tools: ToolService
  fs: FsService
  artifacts: ArtifactService
  approval: ApprovalService
  /** Receives every run event, including stream chunks. */
  onEvent?: (event: RunEvent) => void
}

export interface RunOptions {
  graph: GraphDocument
  input?: Json
  registry: NodeRegistry
  services: RuntimeServices
  runId?: string
  signal?: AbortSignal
  /** Journal sink; in-memory when omitted. */
  journal?: Journal
  /** Execution path prefix for nested runs. Internal. */
  pathPrefix?: string
}

export interface RunResult {
  runId: string
  status: 'completed' | 'failed' | 'cancelled' | 'suspended'
  outputs: Record<string, Json>
  error?: string
}

export async function runGraph(options: RunOptions): Promise<RunResult>
```

### Semantics (normative)

1. Root nodes: a node with no incoming `flow` edges and no incoming `data`
   edges runs first. `core.input` is such a node and receives `RunOptions.input`
   through `NodeContext.input`.
2. A node is runnable when every **connected** data input has a value, every
   **required unconnected** data input is a definition error caught by
   `validateGraph`, and it has at least one flow token if it has incoming flow
   edges. Connected inputs with `waitFor: 'any'` form one group: at least one of
   them must resolve instead of all.
3. On completion, for each data output, propagate to connected inputs. For flow:
   - if the definition declares one or more `flow` outputs, exactly one returned
     output must be `true`; propagate only along that port;
   - if it declares no flow outputs, propagate along every outgoing flow edge.
4. Multiple flow tokens arriving at a node before it runs coalesce into one run
   (M0 is sequential). `flow.map` handles per-item fan-out explicitly.
5. When no node is runnable: if at least one `core.output` executed, complete;
   otherwise fail with a deadlock error naming the blocked nodes.
6. `core.output` nodes contribute their `value` input to `RunResult.outputs`
   under their config port name (default `output`).
7. Every node config is parsed with its definition's zod schema before
   execution; parse failure fails the node, never the whole run silently.
8. Every output value is parsed against its port schema; failure fails the node.
9. Per-run cache: key = sha256 of canonical JSON `{type, version, config,
   inputs, input}` where `input` is `NodeContext.input` (the run seed). Cache
   hits emit `node.cached` and reuse outputs. Disabled when
   `cacheable === false`. Policy is resolved **before** the cache lookup, so a
   `deny` node can never be satisfied by another instance's cached output.
10. Timeout: `definition.timeoutMs` (default 120_000) aborts the node.
11. Retry: `definition.retry` retries on thrown errors with linear backoff.
12. Approval: effective policy = node instance `autonomy` ?? definition
    `autonomy` ?? `{ mode: 'auto' }`. Before `execute`, `ask` calls
    `services.approval.request(...)`; `rejected` fails the node with code
    `APPROVAL_REJECTED`, `cancelled` cancels the run, `allowed-once` proceeds.
    `deny` fails immediately with `AUTONOMY_DENIED`.
13. Cancellation: `AbortSignal` aborts running nodes and stops scheduling.
14. Nested graphs: `ctx.runSubgraph` calls the executor recursively with
    `pathPrefix = ${ctx.path}/` (plus `${label}/` when the caller passes
    `options.label`) and the same services, registry and journal. `flow.loop`
    and `flow.map` pass the iteration/index as the label, so a fork inside a
    loop resumes per iteration. Outputs of the nested run are returned to the
    calling node.
15. `RunEvent`:

```ts
export type RunEvent =
  | { type: 'run.started'; runId: string; graphId: string; graphDigest: string; input: Json; inputDigest: string; at: number }
  | { type: 'node.started'; runId: string; nodeId: string; path: string; attempt: number; at: number }
  | { type: 'node.stream'; runId: string; nodeId: string; path: string; port: string; chunk: Json }
  | { type: 'node.cached'; runId: string; nodeId: string; path: string; at: number }
  | { type: 'node.completed'; runId: string; nodeId: string; path: string; attempt: number; durationMs: number; at: number }
  | { type: 'node.failed'; runId: string; nodeId: string; path: string; attempt: number; error: string; at: number }
  | { type: 'run.completed'; runId: string; at: number; outputs: Record<string, Json> }
  | { type: 'run.failed'; runId: string; at: number; error: string }
  | { type: 'run.cancelled'; runId: string; at: number }
```

`node.stream` is delivered to `services.onEvent` but never appended to the
journal. Nested runs (`pathPrefix` non-empty) emit node-level events only; the
`run.*` events belong to the top-level run.

Approval races the request against `policy.timeoutMs` and the run signal. A
timeout rejects unless `onTimeout: 'approve'`; an abort cancels the run. Node
logs go to the optional `services.onLog` sink.

## 7. `@z1/nodes` — built-in nodes

All ids are namespaced `z1.<name>`.

| id | inputs | outputs | notes |
| --- | --- | --- | --- |
| `z1.core.input` | — | `value` (data Json), `out` (flow) | root; value = `ctx.input` |
| `z1.core.output` | `in` (flow), `value` (data Json) | — | config `{ port?: string }` |
| `z1.core.const` | — | `value` (data Json) | root; config `{ value: Json }` |
| `z1.core.template` | `vars` (data Json, optional) | `text` (data string) | `{{a.b}}` lookup |
| `z1.flow.if` | `in` (flow), `condition` (data boolean) | `then` (flow), `else` (flow) | returns exactly one `true` |
| `z1.flow.loop` | `in` (flow), `seed` (data Json, optional) | `out` (flow), `result` (data Json), `iterations` (data number), `completed` (data boolean) | config `{ body: GraphDocument, maxIterations: number }`; body receives `{ value, iteration }`, outputs `value` and optional `done` (no `done` ⇒ run to the cap; `completed` is false on cap) |
| `z1.flow.map` | `in` (flow), `items` (data Json[]) | `out` (flow), `results` (data Json[]) | config `{ body: GraphDocument, maxItems?: number }`; body receives `{ item, index }`, outputs `value`; sequential in M0; exceeding `maxItems` is an error, not truncation |
| `z1.core.fail` | `in` (flow) | — | config `{ message }`; throws, turning a gated branch into a failed run |
| `z1.graph.subgraph` | `in` (flow), `input` (data Json, optional) | `out` (flow), `output` (data Json) | config `{ graph: GraphDocument, outputPort?: string }`; returns that port, else the whole outputs map |
| `z1.llm.model` | — | `model` (data ModelHandle) | config `ModelHandle` fields; root |
| `z1.llm.chat` | `in` (flow, optional), `model` (data ModelHandle, optional), `messages` (data ChatMessage[], optional), `prompt` (data string, optional), `system` (data string, optional) | `out` (flow), `text` (data string), `message` (data ChatMessage), `toolCalls` (data ToolCall[]), `hasToolCalls` (data boolean), `usage` (data Json) | config `{ model?: ModelHandle; system?: string; maxTokens?: number }`; a connected `model` port wins over config; a connected `system` port wins over config (empty/whitespace ⇒ none); `prompt` is used only when `messages` is empty; streams text via `ctx.emit('text', …)` |
| `z1.tool.call` | `in` (flow, optional), `name` (data string, optional), `args` (data Json) | `out` (flow), `result` (data Json), `isError` (data boolean) | config `{ name?: string }`; config is used only when the `name` port is absent |
| `z1.core.get` | `in` (flow, optional), `value` (data Json) | `out` (flow), `value` (data Json) | config `{ path }`; array indices; prototype keys blocked; missing → null |
| `z1.core.concat` | `in` (flow, optional), `a` (data Json[]), `b` (data Json) | `out` (flow), `value` (data Json[]) | array `b` spreads, otherwise appends |
| `z1.core.message` | `in` (flow, optional), `content` (data Json), `toolCallId` (string, optional), `toolCalls` (array, optional) | `out` (flow), `message` (data object) | config `{ role }`; non-string content stringified |
| `z1.core.last` | `in` (flow, optional), `items` (data Json[]) | `out` (flow), `value` (data Json) | last item or null |
| `z1.core.merge` | `in` (flow, optional), `a` (data Json, optional, `waitFor: any`), `b` (data Json, optional, `waitFor: any`) | `out` (flow), `value` (data Json) | first defined input |
| `z1.core.value` | `in` (flow) | `out` (flow), `value` (data Json) | config `{ value }`; a branch-local constant |
| `z1.memory.context` | — | `text` (data string), `messages` (data ChatMessage[]) | root; builds the branch-tree envelope through `ctx.memory` |
| `z1.prompt.section` | `vars` (data object, optional) | `fragment` (data object) | config `{ id, slot, priority, required, body }`; renders `{{path}}` from vars |
| `z1.prompt.stack` | `fragments` (data object[]) | `text` (string), `hash` (string), `sections` (object[]), `tokens` (number) | config `{ budgetTokens? }`; orders by slot/priority, dedupes, drops optional over budget |
| `z1.prompt.text` | — | `text` (string), `hash` (string) | config `{ text }`; full replacement for a stack |
| `z1.prompt.context` | `memory` (messages/string), `tools` (array), `autonomy` (string), `graph` (object) — all optional | `vars` (object) | normalises values for `{{memory}}`/`{{tools}}`/`{{autonomy}}`/`{{graph}}` |

Nested-graph body contract: the body must contain exactly one rooted
`z1.core.input` (fed `{ value, iteration }`) and exactly one `z1.core.output`
whose input port is `value`.

## 8. `@z1/cli`

```
z1 list
z1 validate <graph.json>
z1 run <graph.json> [--message <text> | --input <json> | --input-file <path>] [--json] [--trace] [--approve auto|ask|deny] [--module-approve ask|auto|deny] [--db <path>] [--resume <runId>] [--suspend]
```

- `run` uses a built-in `MockLlmService` in M0: it returns a deterministic
  assistant message derived from the last user message; if the message contains
  the literal token `[[tool:<name>]]`, it emits a tool call.
- `--approve ask` prompts on stdin: `approve <action> <target>? [y/N]`.
- `--json` prints `{ runId, status, outputs }` to stdout and nothing else.
- `--trace` prints every run event as one JSON line to stderr.
- Exit codes: 0 completed, 1 failed, 2 invalid graph/usage, 3 cancelled,
  4 suspended (M1).

## 9. Journal (M1)

`@z1/journal` uses `node:sqlite` (`DatabaseSync`) at `.z1/runs.db` in the
workspace by default. Tables: `runs`, `events`, `blobs`. Append is synchronous
and fsync'd. Resume replays completed nodes from the journal and skips them.
Approval pauses append `approval.requested` and return `status: 'suspended'`;
`z1 run --resume <runId>` continues.

## 10. Definition of done for M0

- `pnpm -C z1 build` exits 0.
- `pnpm -C z1 test` exits 0 with at least: graph validation (6 cases),
  executor (linear, if, loop, cache hit, deadlock, cancellation, node throw,
  approval allowed/rejected/deny), node registry, CLI smoke.
- `pnpm z1 run z1/examples/hello.graph.json --input '"world"' --json` prints a
  JSON result with `status: "completed"`.
- `pnpm z1 run z1/examples/agent.graph.json --input '{"prompt":"..."}' --json`
  completes a model→tool→model loop using the mock provider.
- Upstream `pnpm run build` still passes 10/10 (checked once, not per task).

## 11. Service modules (R3)

A module may contribute ambient services in addition to (or instead of) nodes.
A service-only module declares `nodes: []` and a non-empty `services` list:

```json
{
  "schemaVersion": 1,
  "id": "com.example.echo-llm",
  "version": "1.0.0",
  "title": "Echo LLM service",
  "license": "MIT",
  "engines": { "z1": ">=0.1.0" },
  "entry": "index.js",
  "nodes": [],
  "services": [{ "id": "llm", "kind": "llm", "mode": "worker" }]
}
```

`services` is optional. Each declaration has a unique-within-module `id`, a
`kind` of `llm | tools | fs | artifacts | memory`, an optional `mode` of
`worker | host`, and an optional `trusted` boolean. Duplicate ids in one
manifest, unknown kinds and unknown modes are manifest errors; the same kind
declared by two different modules is not.

**`mode` defaults to `worker`.** A legacy declaration with no `mode` and
`trusted: true` is a host service, so pre-mode manifests keep working.

- `mode: "worker"` runs the service in the module's child process, next to its
  nodes. It reaches the host only through the same capability broker as a node:
  `ctx.llm`/`ctx.tools`/`ctx.fs`/`ctx.net` are brokered, its `fs`/`net` calls
  are checked against the manifest's capabilities, and an approval request from
  worker code is refused (`rejected`). A worker mode declaration must not also
  say `trusted: true`.
- `mode: "host"` imports the service into the host process. It requires
  `trusted: true`, because the approval grant is then the only boundary: an
  approved host service can reach the whole process. Declaring `mode: "host"`
  without `trusted: true`, or `mode: "worker"` with it, is a manifest error.

Worker isolation is process-level, not a container: the child runs under Node's
permission model with read access to its module directory and write access only
to declared `fs.write` globs. It sees no host memory and cannot call a host
service that was not brokered to it.

A manifest declares the brokered calls its nodes and worker services may use
(`capabilities` is optional and defaults to nothing granted):

| key | grant |
| --- | --- |
| `fs.read` | glob list for `ctx.fs.read` and `ctx.fs.list` |
| `fs.write` | glob list for `ctx.fs.write` |
| `net.hosts` | host glob list for `ctx.net.request` (HTTP(S) only) |
| `process.spawn` | command glob list for `ctx.process.run` |
| `llm.providers` / `true` | model providers for `ctx.llm.chat` |
| `tools.names` / `true` | tools for `ctx.tools.call` |

`fs.list` lists one directory level: `{ path, entries: [{ name, path, type,
size? }] }`, sorted by name, with `type` one of `file | dir | symlink`.
Symlinks are reported as `symlink` and never followed. `fs.list` is gated by
`fs.read`, so a module can only list inside its granted read patterns.

`process.run` spawns directly with `shell: false` and an argv array, so no
argument is ever interpreted by a shell. `process.spawn` is a **command
allowlist**: each entry is an anchored glob matched against the full command
string or its basename, case-sensitively (`'*'` grants every command). An
absent or empty list denies every command. An explicit `cwd` must be inside
`fs.read`; otherwise the call is denied and audited. `timeoutMs` defaults to
30 000 ms and is capped at 300 000 ms; `maxOutputBytes` is a shared
stdout+stderr budget, defaults to 1 MiB, and is capped at 5 MiB. Hitting either
limit kills the child, and `truncated` reports an output overrun. The child
environment is minimal `{ PATH, ...request.env }`.

The entry exports factories alongside any `nodes`:

```js
export const services = {
  llm: (ctx) => ({
    async chat(request, onDelta) { /* ... */ },
    dispose() { /* optional, host mode */ },
  }),
}
```

A worker-mode entry must also export `nodes` (an empty array is fine) because
the child bootstrap requires it. Each factory receives
`{ moduleId, version, directory, config, log, get }`.
Required instance methods per kind: `llm.chat`, `tools.call`/`list`,
`fs.read`/`write`, `artifacts.put`/`get`, `memory.buildContext`. For a worker
service, `artifacts` crosses IPC as base64: `put({ data, mime })` returns
`{ hash, mime }`, `get({ hash })` returns `{ data, mime }`. `dispose()` is
optional and called once when the runtime closes for host services; a worker
service is stopped with its process.

Service modules are approved through the normal store; the approved `services`
list is recorded on the grant and in the audit log as declared, including
`mode`/`trusted`. **The grant is the authority**: a grant may approve fewer
services or capabilities than the manifest requests, and a service the grant
omits is never started. A pre-R3 grant (`services: []`) approves no services.
`z1 module list` reports the grant, while `z1 module propose` reports the
manifest.

The runtime creates **one `ModuleRuntime` per process** on the first run and
keeps it: each active module has one child that hosts its nodes and its granted
worker services, reused by every later run. A crashed child is respawned
lazily, and a failed load discards the runtime so the next run retries. Service
resolution happens per run and resolves one instance per kind. Multiple
providers of the same kind resolve to the highest module version across both
modes; ties keep the lower module id, and the choice is logged. Service
precedence for a run is:

```
overrides > approved service module > built-in default
```

Built-in defaults are the provider registry's `llm` (mock when `live` is off),
the mock `tools`/`fs`/`artifacts`, and `BranchMemory` when enabled. Module code
does not need a per-call approval, but it may ask: an approval request from a
worker service carries the run id of the run that called it, so it reaches that
run's approval channel (and only that one). A request with no known run is
refused cleanly. Host-mode services run in-process and use the grant alone.

`RuntimeConfig.useModules` (env `Z1_USE_MODULES`, file key `useModules`) is the
master switch: `false` disables node modules and service modules, host and
worker alike, so no third-party code runs. `RuntimeConfig.useServiceModules`
(default `true`, env `Z1_SERVICE_MODULES=0|1`, file key `useServiceModules`)
disables only services; a run may override it per invocation with
`RunOverrides.useServiceModules` (CLI `--no-service-modules`), and the choice
is not cached — a later run can use the service again. The CLI exposes
`--no-modules` and `--no-service-modules` on `run`, and
`--no-service-modules` on `serve` and `studio`.
