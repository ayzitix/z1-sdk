# z1 SDK — task board

Status: `[ ]` todo, `[~]` in progress, `[x]` done, `[!]` blocked.
Contract: `z1/SPEC.md`. Lead: the main agent. Implementation: subagents.
Rule: after every implementation task, a separate review subagent reads the diff
and runs the checks. The lead commits and verifies at milestone boundaries.

## M0 — working headless graph engine

- [x] T0 Scaffold `z1/` workspace: packages `graph`, `node`, `runtime`, `nodes`,
  `journal`, `protocol`, `server`, `host-dsh`; app `cli`; tsconfigs, vitest,
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
- [ ] T13 Review + commit.
- [x] T14 `@z1/protocol`: JSON-RPC method map + event types + transport.
- [ ] T15 `@z1/server`: WS server, run control, approval, artifacts, module registry.
- [ ] T16 CLI `z1 serve`; reconnecting client smoke test.
- [ ] T17 Review + commit.

## M3 — canvas

- [ ] T18 `z1/apps/canvas`: React + React Flow, palette, inspector, run overlay,
  approval queue, branch tree panel.
- [ ] T19 e2e: edit graph, run, approve, see output.
- [ ] T20 Review + commit.

## Later

- Module packaging/approval/rollback and sandboxed worker host (M4).
- Agent-as-graph template + context assembly from the branch tree (M5).
- z1-app editor integration (M6).
