# z1 SDK — task board

Status: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked.
Contract: `z1/SPEC.md`. Lead: the main agent. Implementation: subagents.
Rule: after every implementation task, a separate review subagent reads the diff
and runs the checks. The lead commits and verifies at milestone boundaries.

## M0 — working headless graph engine

- [x] T0 Scaffold `z1/` workspace: packages `graph`, `node`, `runtime`, `nodes`,
  `journal`, `protocol`, `server`; app `cli`; tsconfigs, vitest,
  scripts, root wiring, `pnpm install`, build + one trivial test green.
- [x] T1 `@z1/node`: contract types + `defineNode` + `NodeRegistry`.
- [x] T2 `@z1/graph`: document schema, `parseGraph`, `validateGraph`,
  `graphDigest`, nested graph support.
- [x] T3 `@z1/runtime`: executor per SPEC §6, in-memory journal, cache,
  approval policy, events, nested runs.
- [x] T4 `@z1/nodes`: all built-ins in SPEC §7.
- [x] T5 `@z1/cli`: `list/validate/run`, mock LLM, trace, exit codes.
- [x] T6 Examples + integration tests: `hello.graph.json`,
  `agent.graph.json` (model → tool → model loop).
- [x] T7 Review pass + fixes; lead runs build/tests/CLI (146 tests green).
- [ ] T8 Commit M0.

## M1 — durability, approvals, real provider

- [x] T9 `@z1/journal`: SQLite (`node:sqlite`), append/read/list/fork, blobs.
- [x] T10 Executor resume: skip completed nodes, `run.suspended`,
  `approval.requested/decided`, `z1 run --resume`.
- [x] T11 `@z1/provider-openai`: OpenAI-compatible streaming provider
  (River/OpenAI), local SSE test server; real River turn verified.
- [x] T12 Branch tree: `z1 tree`, `z1 fork --at`, run lineage.
- [x] T13 Review + commit.

## M2 — headless server + protocol

- [x] T14 `@z1/protocol`: JSON-RPC method map + event types + transport.
- [x] T15 `@z1/server`: WS server, run control, approval, artifacts, forks.
- [x] T16 CLI `z1 serve`; end-to-end ws client test.
- [x] T17 Review + commit.

## M3 — canvas

- [x] T18 `z1/apps/canvas`: React + React Flow, palette, inspector, run overlay,
  approval queue, branch tree panel.
- [x] T19 Browser e2e: load graph, run, approve, see output (Chromium, zero
  console errors).
- [x] T20 Review + commit.

## M4 — executable modules

- [ ] T21 `@z1/module`: manifest schema, capability model, integrity,
  local store, grants, rollback, hash-chained audit log.
- [ ] T22 `@z1/node-host`: child-process worker, Node permission flags,
  capability RPC (llm/tools/fs/net/approval), streaming, cancel, crash containment.
- [ ] T23 Runtime/CLI integration: load installed modules into the registry,
  `z1 module list/propose/approve/rollback`, end-to-end fixture module.
- [x] T24 Protocol/server/canvas: module inventory + approval panel.
- [x] T25 Review + commit (modules end to end).

## M5 — agent as a graph and branch memory

- [x] T26 `waitFor: any` ports and assembly nodes (`get`, `concat`, `message`,
  `last`, `merge`, `value`), flow-gated branches.
- [x] T27 `@z1/agent`: the default tool loop built from nodes, example graph.
- [x] T28 `@z1/memory`: ancestry/siblings/recent, context envelope,
  `memory.context` node, `z1 memory context`.
- [x] T29 iteration-scoped execution paths (fork inside a loop replays only the
  earlier iterations).
- [x] T30 Review + commit.
- [x] T31 Provider retry on 429/5xx with backoff and `retry-after`.
  Live River verification: tool call + second model round.

## M6 — prompt as nodes

- [x] T32 `@z1/prompt`: sections, slots, priorities, budget, hash, defaults,
  role presets, `buildPrompt`.
- [x] T33 nodes `prompt.section/stack/text/context`; `llm.chat.system` input.
- [x] T34 agent graph rebuilt on prompt nodes; canvas section editor.
- [x] T35 Review + commit.

## M7 — the base as a usable tool

- [x] T36 Server-side graph storage with versions; node defaults + config schemas.
- [x] T37 Canvas autosave/conflict handling, palette defaults, schema forms;
  `z1 studio` serves the built canvas from the server.
- [x] T38 Per-node run inspector (outputs, errors, duration, prompt hash),
  run timeline and branch tree with fork-from-path.
- [x] T39 Review + commit.

## Correctness fixes (from the bug audit)

- [x] Prompt is rendered once (braces in memory survive); empty sections skipped.
- [x] Memory is framed as untrusted history in `<memory>`.
- [x] `run.started` records input + digest; resume with a different input fails
  with `RESUME_MISMATCH` instead of replaying stale output.
- [x] Parallel tool calls are all executed with matching `tool_call_id`s.
- [x] `maxSteps` exhaustion fails with `step limit reached`, never returns tool JSON.
- [x] `--message <text>` for plain input; `--input` stays JSON.
- [x] Module approvals default to `ask`; `--approve auto` does not cover them.
- [x] Provider: stream errors throw, malformed tool args throw, synthetic ids are unique.
- [x] Server: O(1) tee journal, memory attached, approvals keyed by id.

## M8 — modular composition

- [x] T40 Provider registry as data; `@z1/provider`, config-only providers.
- [x] T41 `@z1/bootstrap` + `z1.config.json`; CLI and server share one runtime.
- [x] T42 Agent template and static templates as data (`@z1/template`,
  `z1 run --template`, `z1 template list`).
- [x] T43 `RunJournal` interface (no raw SQL in CLI), centralized paths,
  `host-dsh` removed.
- [ ] T44 Prompt presets as data files (deferred; the prompt is already nodes).

## M9 — services in modules and the audit fixes

- [x] R3 service modules: manifest `services` with `mode`/`trusted`, worker-mode
  adapters, `ModuleServiceRuntime` for host mode, bootstrap precedence
  (`overrides > service module > built-in`), echo-llm example.
- [x] Server fork uses own sequence numbers; journal rejects unknown runs and
  past-end forks.
- [x] Resume without repeating the input works; different input still fails.
- [x] Template loading is lazy; a malformed file only affects template commands.
- [x] Approval prompts show the actual capability patterns.
- [x] `--model` without `--live` warns; `--template id@version`; template flags
  require `--template`.
- [x] Config env flags, duplicate provider rejection, `beginRun`/`close` race,
  failed listen closes the runtime, runId reuse conflict.

## M10 — services in the sandbox

- [x] T45 worker RPC for services: call/result/delta/cancel, timeout, crash
  rejection, service-only modules.
- [x] T46 manifest `mode: worker|host` (worker default, host requires
  `trusted: true`), proxy adapters for llm/tools/fs/artifacts/memory,
  bootstrap starts worker services, pid-isolation and crash tests.
- Known limitations: a module with nodes + worker services starts two child
  processes; worker `dispose()` is not called (the process is killed); worker
  services cannot request approval; service selection is cached per runtime.

## M11 — worker services hardened

- [x] One child per module hosts both nodes and services; node and service
  calls share the same pid across runs; SIGKILL respawns with a new pid.
- [x] Service `dispose()` is called over RPC before the child is killed.
- [x] Worker services reach the current run's approval service (`runId` on
  every service call); allow/reject/absent are tested.
- [x] Per-run `useServiceModules` and `--no-service-modules` select services
  without a permanent cache.
- [x] Node-only workers never read service factories; a throwing service no
  longer breaks node modules.
- [x] `--no-modules` disables node and service modules; grants (not manifests)
  are the authority; `llm`/`tools` capabilities are enforced; `ctx.get` is
  module-scoped.
- Known: a service-only child may still start if the runtime was constructed
  with services enabled and a later run disables them; module-node approvals
  resolve to the latest live run (ambiguous for concurrent runs).
