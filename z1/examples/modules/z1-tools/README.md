# z1 tools module

A worker-mode `tools` service for `z1`: a small, well-behaved tool stack an
agent graph can drive — read, write, patch, search, shell, read-only git and a
workspace todo list. It is an example module, not host code: the entry is plain
ESM with `node:` builtins only, and the manifest's grant decides how far it can
reach.

> **v1 has no approvals.** No tool calls `ctx.approval`. `write`, `edit`,
> `apply_patch`, `move`, `mkdir` and `shell` run as soon as the model asks, so
> only point this module at a workspace you are willing to let a model rewrite.
> The capability grant is the only boundary.

## Tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `read` | `{ path, offset?, limit? }` | numbered lines: `1\| text`; a `truncated` note when the window ends early |
| `write` | `{ path, content }` | `wrote <path> (<n> bytes)` |
| `edit` | `{ path, oldText, newText, replaceAll? }` | `edited <path> (<n> replacements)` |
| `apply_patch` | `{ patch }` | `patched <n> blocks in <m> files`, then `<path> (+a -r)` per file |
| `list` | `{ path, recursive?, maxDepth? }` | `dir <path>` and `file <path> (<size>)` |
| `glob` | `{ pattern, path? }` | matching paths, one per line (`*`, `**`, `?`) |
| `grep` | `{ pattern, path?, glob?, caseSensitive?, context?, maxResults? }` | `path:line: text`; context lines use `path-line- text` |
| `tree` | `{ path?, depth? }` | compact tree with `├──`/`└──` |
| `stat` | `{ path }` | `type size mtime path` |
| `mkdir` | `{ path }` | `created <path>` |
| `move` | `{ from, to }` | `moved <from> -> <to>` |
| `shell` | `{ command, args?, cwd?, timeoutMs? }` | `exit <code>`, then `--- stdout ---` / `--- stderr ---` sections |
| `git.status` | `{}` | `git status --porcelain` (empty when clean) |
| `git.diff` | `{ path?, staged?, ref? }` | unified diff |
| `git.log` | `{ path?, limit? }` | `hash date subject`, newest first |
| `system.info` | `{}` | `platform`, `arch`, `node`, `workspace` lines |
| `todo.write` | `{ items: [{ text, status? }] }` | `wrote .z1/todos.json (<n> items)` |
| `todo.read` | `{}` | pretty-printed JSON from `.z1/todos.json` |

Every result is text and every failure throws an `Error` that names the path or
argument at fault. Tools that discover positions use `path:line` (`grep`), so a
line from one result can be fed to `read`'s `offset`.

### Paths

`ctx.workspace` is the project folder. Relative paths resolve there, absolute
paths are used as given, and results display a workspace-relative path when the
target is inside the workspace (`notes/a.txt`, `.` for the root) and an absolute
path otherwise. `write` creates parent directories.

### Todo list

`todo.write` replaces `.z1/todos.json` with `{ "items": [{ "text", "status" }] }`,
pretty-printed. Statuses are `pending`, `in_progress` and `done`; `pending` is
the default. `todo.read` returns the same JSON, or an empty list when the file
does not exist.

## Limits

- `read`: 1 MiB per file, 2000 lines per call, 1-based `offset`.
- `list`, `glob`, `grep`: depth 8, 5000 entries; `glob` and `grep` skip `.git`.
- `grep`: 200 matches by default, `context` 0–20, 1 MiB per file, binaries skipped.
- `tree`: depth 7 (default 3), 3000 entries.
- `shell`: 30 s by default, 300 s maximum; argv only, never a shell string.
- `git.log`: 20 commits by default, 1000 maximum.
- `apply_patch`: every SEARCH block must match exactly once; all blocks are
  validated first, so one mismatch writes nothing.

## stat and move

The broker exposes `fs.read`/`fs.write`/`fs.list`, and the worker runs under
Node's permission model, which denies `stat`, `readdir` and `rename` even on
write-granted paths. So `stat` and `move` run a minimal `node -e` helper through
`ctx.process.run` (argv array, no shell string, no dependency); `mkdir` uses
`node:fs`, which the write grant allows. Reads and writes still go through the
broker, so grants and denials stay auditable.

## 1. Propose

```sh
z1 module propose z1/examples/modules/z1-tools --modules-dir /tmp/z1-modules
```

Proposing copies the directory into the store, hashes it, and prints the id, the
`tools` service and the requested capabilities. Nothing executes yet.

## 2. Approve

```sh
z1 module approve com.z1.tools --modules-dir /tmp/z1-modules
```

The printed grant is broad on purpose:

```json
{
  "fs": { "read": ["/**"], "write": ["/**"] },
  "process": { "spawn": ["*"] }
}
```

`/**` covers every absolute path and `spawn: ["*"]` every executable. Narrow the
manifest (for example `"fs": { "write": ["${moduleDir}/**"] }`) if the module
only needs a corner of the disk; the host re-checks every path and command and
records denials in `z1 module audit`.

## 3. Run

```sh
z1 module list --modules-dir /tmp/z1-modules
z1 run graph.json --modules-dir /tmp/z1-modules --approve ask
```

Any graph node that calls the run's tool service (for example `z1.agent.loop`)
now sees the table above.
