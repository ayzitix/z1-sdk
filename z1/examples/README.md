# z1 examples

Graph documents you can validate and run with the CLI.

```sh
# Render a template from the run input.
pnpm z1 run z1/examples/hello.graph.json --input '{"name":"world"}' --json

# Model -> tool -> model loop against the built-in mock provider. The mock
# emits a tool call when the user text contains `[[tool:echo]]`.
pnpm z1 run z1/examples/agent.graph.json --input '"[[tool:echo]] hello"' --json
```

Add `--trace` to stream every run event as a JSON line on stderr, or
`--approve auto|ask|deny` to control node autonomy. `--message <text>` passes
the run input as a UTF-8 string used as-is (never JSON-parsed, newlines kept);
it is mutually exclusive with `--input`/`--input-file`, and `--input` still
takes JSON.

`--module-approve ask|auto|deny` (default `ask`) is a separate policy for
`ctx.approval.request(...)` made by module code. It is independent of
`--approve`, so `--approve auto` alone does not grant module approvals; a
non-TTY `ask` rejects with a message instead of blocking.

## Live provider

`agent.live.graph.json` has the same topology, but its model node asks for
`river` / `deepseek-ai/DeepSeek-V4.1-Flash-1017`. `--live` routes `river` and
`openai` model handles to the OpenAI-compatible client; every other provider
still uses the mock.

```sh
export RIVER_API_KEY=...            # OPENAI_API_KEY for provider "openai"
pnpm z1 run z1/examples/agent.live.graph.json --live \
  --input '"[[tool:echo]] hello"' --json

# Optional endpoint overrides, shared or per provider:
#   Z1_OPENAI_BASE_URL, RIVER_BASE_URL, OPENAI_BASE_URL
```

Without `--live` the run stays fully offline: the model node resolves to a
handle but all chat calls go to the deterministic mock. `--live` fails with a
clear message and exit code 1 when the credential for a provider the graph uses
is missing; no run is recorded.

## Runs, trees and forks

Every run is journaled to `.z1/runs.db` (override with `--db <path>`).

```sh
# One line per run, newest first:
#   <runId>  <status>  <graphId>  <digest[:12]>  <created ISO>  <- <parent>@<seq>
pnpm z1 tree --db /tmp/z1.db
pnpm z1 tree --db /tmp/z1.db --json     # RunRecord[]

# Fork a run at an execution path (the node's `node.started` path) ...
pnpm z1 fork run_<id> --at template --db /tmp/z1.db
# ... or at a raw sequence number, then resume the fork:
pnpm z1 run z1/examples/hello.graph.json --resume run_<fork> --approve auto --db /tmp/z1.db
```

A path fork records `seq - 1`, so the node at that path re-executes on resume
while the earlier nodes replay from the journal. `fork` only creates the record;
it never runs the graph.

## Loop and map bodies

Both `z1.flow.loop` and `z1.flow.map` run a nested *body graph*. The body's
`z1.core.input` node receives a port-keyed record, and results come back from
the body's `z1.core.output` nodes.

`z1.flow.loop` — config `{ body, maxIterations }`:

- input: `{ value, iteration }` (`value` starts at `seed`, or `null` when the
  optional `seed` port is not connected)
- output: port `value` feeds the next iteration; optional port `done` stops the
  loop when it is `true`
- a body with no `done` port runs exactly `maxIterations` times

`z1.flow.map` — config `{ body, maxItems? }`:

- input: `{ item, index }`
- output: port `value` per item; results keep input order
- `maxItems` caps the item count: a longer array fails the node instead of
  being truncated

```json
{
  "type": "z1.flow.loop",
  "config": {
    "maxIterations": 5,
    "body": {
      "schemaVersion": 1,
      "id": "body",
      "nodes": [
        { "id": "bin", "type": "z1.core.input", "version": "1.0.0", "config": {}, "position": { "x": 0, "y": 0 } },
        { "id": "tpl", "type": "z1.core.template", "version": "1.0.0", "config": { "template": "{{value}}!" }, "position": { "x": 200, "y": 0 } },
        { "id": "out", "type": "z1.core.output", "version": "1.0.0", "config": { "port": "value" }, "position": { "x": 400, "y": 0 } }
      ],
      "edges": [
        { "id": "b1", "kind": "data", "from": { "node": "bin", "port": "value" }, "to": { "node": "tpl", "port": "vars" } },
        { "id": "b2", "kind": "data", "from": { "node": "tpl", "port": "text" }, "to": { "node": "out", "port": "value" } }
      ]
    }
  }
}
```
