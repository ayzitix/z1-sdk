# z1 tools module

A worker-mode `tools` service for `z1`: filesystem, shell and HTTP tools that
any graph touching the run's tool service can call. It is the module form of
the built-in mock tools, so an agent graph gets real disk and network access
without the host process growing built-ins.

`index.js` imports only `node:path`; every privileged action goes back through
the host's capability broker (`ctx.fs`, `ctx.process`, `ctx.net`,
`ctx.approval`), so the manifest grant — not the module — decides the blast
radius.

## 1. Propose

```sh
z1 module propose z1/examples/modules/z1-tools --modules-dir /tmp/z1-modules
```

Proposing copies the directory into the store, hashes it, and prints the id,
the `tools` service and the requested capabilities. Nothing executes yet.

## 2. Approve

```sh
z1 module approve com.z1.tools --modules-dir /tmp/z1-modules
```

The printed grant is broad on purpose and worth reading before you accept it:

```json
{
  "fs": { "read": ["/**"], "write": ["/**"] },
  "process": { "spawn": ["*"] },
  "net": { "hosts": ["*"] }
}
```

`/**` covers every absolute path, `spawn: ["*"]` every executable, and
`hosts: ["*"]` every host. Narrow the manifest (for example
`"fs": { "read": ["${moduleDir}/**"] }`) if the module only needs a corner of
the disk; the host re-checks every path, command and hostname the module asks
for and records denials in `z1 module audit`.

## 3. Run

```sh
z1 module list --modules-dir /tmp/z1-modules
z1 run graph.json --modules-dir /tmp/z1-modules --approve ask
```

Any active graph node or module that calls the run's tool service (for example
`z1.agent.loop`) now sees these tools:

| Tool | Arguments | Result |
| --- | --- | --- |
| `read` | `{ path, offset?, limit? }` | `{ path, content, offset, limit, totalLines, truncated }` |
| `write` | `{ path, content }` | `{ path, bytes }` |
| `edit` | `{ path, oldText, newText, replaceAll? }` | `{ path, replacements }` |
| `list` | `{ path, recursive?, maxDepth? }` | `{ path, entries, truncated }` |
| `glob` | `{ pattern, path? }` | `{ matches, truncated }` |
| `shell` | `{ command, args?, cwd?, timeoutMs? }` | the host `process.run` result: `code`, `signal`, `stdout`, `stderr`, `truncated`, `durationMs` |
| `http` | `{ url, method?, headers?, body? }` | `{ status, headers, body, truncated }` |

Path rules: an absolute path is used as given, a relative one resolves against
`ctx.workspace`, and every result reports the absolute path. `read` is 1-based
by line, defaults to 2000 lines and refuses files over 1 MiB. `edit` requires a
single occurrence unless `replaceAll` is true. `list`/`glob` stop at 8 levels
and 5000 entries.

## Approvals

`read`, `list` and `glob` never ask: they are bounded and non-mutating.

`write`, `edit`, `shell` and `http` call
`ctx.approval.request({ action: 'tool.<name>', target, preview })` first — for
example `tool.write` with `{ path, bytes }`, `tool.shell` with
`{ command, args, cwd, timeoutMs }`, `tool.http` with `{ method, url }`. They
proceed only on `allowed-once`; any other decision throws `approval rejected`
and nothing is written, spawned or sent. In a run that resolves no approval
channel the tool call fails instead of proceeding silently.
