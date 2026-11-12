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
`--approve auto|ask|deny` to control the mock approval service.

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
