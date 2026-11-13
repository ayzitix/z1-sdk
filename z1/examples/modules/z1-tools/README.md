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
| `read` | `{ path, offset?, limit? }` | numbered lines: `1\| text`; a `truncated` note when the window ends early; refuses files over 1 MiB and binaries |
| `write` | `{ path, content }` | `wrote <path> (<n> bytes)` |
| `edit` | `{ path, oldText, newText, replaceAll? }` | `edited <path> (<n> replacements)` |
| `apply_patch` | `{ patch }` | `patched <n> blocks in <m> files`, then `<path> (+a -r)` per file |
| `list` | `{ path, recursive?, maxDepth? }` | `dir <path>`, `file <path> (<size>)`, `link <path>` |
| `glob` | `{ pattern, path? }` | matching paths, one per line (`*`, `**`, `?`) |
| `grep` | `{ pattern, path?, glob?, caseSensitive?, context?, maxResults? }` | `path:line: text`; context lines use `path-line- text` |
| `tree` | `{ path?, depth? }` | compact tree with `├──`/`└──` |
| `stat` | `{ path }` | `type size mtime path` |
| `mkdir` | `{ path }` | `created <path>` |
| `move` | `{ from, to }` | `moved <from> -> <to>` |
| `shell` | `{ command, args?, cwd?, timeoutMs? }` | `exit <code>` or `killed <signal> (timeout after <ms> ms)`, then `--- stdout ---` / `--- stderr ---` sections |
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

`ctx.workspace` is the project folder and the only place these tools may touch.
Relative paths resolve there; an absolute path is accepted only when its real
path — symlinks followed — is the workspace or below it. A target that does not
exist yet is judged by the real path of its nearest existing parent, so `..`
escapes, absolute paths outside and symlinks pointing outside all fail with
`path escapes workspace: <path>`. The check applies to `read`, `write`, `edit`,
`apply_patch`, `list`, `glob`, `grep`, `tree`, `stat`, `mkdir`, `move` (both
ends) and `shell.cwd`; only `system.info` reports the workspace path itself.

Results display a workspace-relative path when the target is inside the
workspace (`notes/a.txt`, `.` for the root) and an absolute path otherwise.
`write` creates parent directories. `read`, `edit` and `apply_patch` keep a
file's line endings: `edit` and `apply_patch` match LF or the file's own CRLF
style, normalise the replacement to that style, and leave every other line
byte-for-byte unchanged.

### Todo list

`todo.write` replaces `.z1/todos.json` with `{ "items": [{ "text", "status" }] }`,
pretty-printed. Statuses are `pending`, `in_progress` and `done`; `pending` is
the default. `todo.read` returns the same JSON, or an empty list when the file
does not exist.

## Limits

- `read`: 1 MiB per file, 2000 lines per call, 1-based `offset`. The size and a
  NUL in the first 8 KiB are checked with `ctx.fs.stat`/a head sniff before the
  file is loaded, so a 4 GiB file is never read; both fail with a clear error
  (`file is <n> bytes; use shell sed -n`, `binary file: <path>`).
- `list`, `glob`, `grep`: depth 8, 5000 entries; `glob` and `grep` skip `.git`.
- `grep`: 200 matches by default, `context` 0–20, 1 MiB per file. Files over
  1 MiB and files with a NUL byte in the first 8 KiB are skipped silently.
- `tree`: depth 7 (default 3), 3000 entries.
- `shell`: 30 s by default, 300 s maximum; argv only, never a shell string.
  A child that dies from a signal reports `killed <signal>`, and a kill by the
  tool's own deadline adds `(timeout after <ms> ms)`.
- `git.log`: 20 commits by default, 200 maximum.
- `git.diff`/`git.log`: a `ref` starting with `-` is rejected; the ref is passed
  after `--end-of-options` and pathspecs after `--`, so no argument can become
  an option (`--output=...` cannot redirect the diff into a file).
- `apply_patch`: every SEARCH block must match exactly once; all blocks are
  applied in memory first, each changed file is written to a sibling temp file
  and renamed into place, and a failure removes the temps and restores every
  original.

## Symlinks

The broker reports a symlink as its own entry (`type: "symlink"`). Walks never
follow one: `list` shows `link <path>`, and only real directories are entered,
so `glob`, `grep` and `tree` cannot be steered out of the workspace by a link.
`stat` uses `lstat`, so it reports the link itself. A path that resolves through
a symlink to the outside is refused by the containment check before use.

## stat, move and rename

The broker exposes `fs.read`/`fs.write`/`fs.list`/`fs.stat`, and the worker runs
under Node's permission model, which denies `realpath`, `rename` and `readFile`
even on write-granted paths. `stat` therefore uses the brokered `ctx.fs.stat`,
while path containment (`realpath`), `move` (`rename`, with an `EXDEV`
copy-and-delete fallback) and the atomic-patch rename step run minimal
`node -e` helpers through `ctx.process.run`: argv array, no shell string, no
dependency. `mkdir`, `write` and `unlink` use `node:fs`/the broker, which the
write grant allows. Reads and writes still go through the broker, so grants and
denials stay auditable.

`move` is the one operation that is not atomic: the helper's `rename` is atomic
within one filesystem, but an `EXDEV` move copies and then deletes, so an
interruption can leave both copies. Callers that need durability should copy
with `read`/`write` and remove the source themselves.

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
