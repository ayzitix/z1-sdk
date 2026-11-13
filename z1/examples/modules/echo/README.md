# Echo example module

The smallest useful `z1` module. It declares one node,
`com.example.echo.echo`, which reads a `text` input, emits a log line and a
`text` stream chunk, then returns the same text with `!` appended.

The module only runs inside the host worker: `index.js` imports nothing and
uses `ctx.log` / `ctx.emit` / `ctx.inputs`. Its manifest asks for read access to
its own directory (`${moduleDir}/**`) to show the capability grant flow.

## 1. Propose

```sh
z1 module propose z1/examples/modules/echo --modules-dir /tmp/z1-modules
```

Proposing copies the directory into the store, hashes it, and prints the id,
version, node ids, capabilities and integrity. Nothing executes yet.

## 2. Approve

```sh
z1 module approve com.example.echo --modules-dir /tmp/z1-modules
```

Approving records the capability grant, installs the immutable copy, and makes
it the active version. `--future` would also cover later versions; `--json`
prints the grant as data.

## 3. Run

```sh
z1 module list --modules-dir /tmp/z1-modules

z1 run graph.json --modules-dir /tmp/z1-modules --json
```

with a graph node such as:

```json
{
  "id": "echo",
  "type": "com.example.echo.echo",
  "version": "1.0.0",
  "config": {}
}
```

The result is `"hello!"` when the data input is `"hello"`. Every denial is
appended to the store's hash-chained audit log (`z1 module audit`).
