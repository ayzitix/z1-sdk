# `@z1/node-host`

Runs a module node (`z1/SPEC.md` §6–§9) in a child process, brokering every
privileged operation back to host services.

- `ModuleWorker` spawns `process.execPath` with `--permission`,
  `--allow-fs-read=<worker bootstrap>` and `--allow-fs-read=<moduleDir>`, and
  `--allow-fs-write=<pattern>` only for declared `fs.write` patterns. No
  `--allow-child-process`, `--allow-addons` or `--allow-worker`; minimal env
  (`PATH` plus `options.env`); stdio is `['ignore','pipe','pipe','ipc']`.
- Child `ready { nodes }` handshake (10 s), JSON-object messages over IPC with
  ids, cancellation (`cancel`, SIGKILL after 2 s), per-execution timeout
  (default 120 000 ms), and crash containment: a dead child rejects every
  pending execution and `start()` respawns it.
- Module entries are plain, dependency-free ESM exporting `nodes` (or a default
  array) with `{ id, version, title, category, inputs, outputs, execute(ctx) }`.
  `ctx` exposes data inputs, config, run seed, `signal`, `log`, `emit`,
  `llm.chat`, `tools.call/list`, `fs.read/write/list`, `process.run`,
  `net.request`, `approval.request`. `runSubgraph` throws: not available in M4.
- `ctx.fs.list(path)` lists one directory level, gated by `fs.read`:
  `{ path, entries: [{ name, path, type: 'file'|'dir'|'symlink', size? }] }`,
  sorted by name. Symlinks are typed without being followed; there is no
  recursion (callers recurse).
- `ctx.process.run({ command, args?, cwd?, timeoutMs?, maxOutputBytes?, env? })`
  is a brokered spawn: `shell: false` with an argv array and a minimal
  `{ PATH, ...env }` environment. `process.spawn` is a case-sensitive command
  allowlist of anchored globs matched against the full command and its
  basename (`'*'` allows all; absent/empty denies all). An explicit `cwd` must
  be inside `fs.read`, otherwise the call is denied. `timeoutMs` defaults to
  30 000 ms (max 300 000 ms); `maxOutputBytes` is shared across stdout and
  stderr, defaults to 1 MiB (max 5 MiB), and hitting it (or the timeout) kills
  the child. The result is
  `{ code, signal, stdout, stderr, truncated, durationMs }`.
- `moduleNodeDefinition` adapts a declaration plus a live worker into a runtime
  `NodeDefinition`, so the executor handles validation, caching and approval.

## Security note

Node's permission model gates the filesystem and process spawning, but it does
**not** block direct `node:net` or `fetch` calls from module code — the child
can still open sockets, and `ctx.net.request` capability checks only gate the
`ctx.*` API the host brokers. Module code must be reviewed and bundled by the
publisher, and an untrusted module needs an OS-level sandbox (container,
seccomp, network namespace) that this package does not provide. Denials are
reported through `services.onLog` (level `warn`) as an audit hook; they are not
a substitute for sandboxing.

## Tests

`packages/node-host/tests/host.spec.ts` spawns the real child and covers
descriptors, streaming/logs, fs allow/deny, net allow/deny with a local HTTP
server, LLM forwarding, crash + respawn, timeout, abort, undeclared exports,
`runGraph` integration and idempotent `dispose`.
`packages/node-host/tests/capabilities.spec.ts` covers brokered `fs.list`
(sorting, types, sizes, symlinks, deny, missing directory) and `process.run`
(allow/deny, cwd gate, timeout, truncation, env, argv without shell splitting).
