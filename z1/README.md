# z1 SDK

The `z1` workspace behind the CLI: a journaled node-graph agent SDK where model
providers, tools, filesystem access and the agent loop are nodes, and modules
can also provide ambient services.

## Quickstart

```sh
cd z1
pnpm install
pnpm -C z1 build
pnpm -C z1 test

pnpm z1 run --template agent.loop --message 'hello' --json
```

See `SPEC.md` for the normative contract and `examples/` for runnable graphs and
modules.

## Service modules

A module can provide an ambient service instead of (or as well as) nodes. v1
supports `llm`, `tools`, `fs`, `artifacts` and `memory`. A service-only module
declares empty `nodes` and a `services` list:

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

`index.js` exports `services`, a map of factories that receive
`{ moduleId, version, directory, config, log, get }`:

```js
export const nodes = [] // required by the worker bootstrap

export const services = {
  llm: (ctx) => ({
    async chat(request, onDelta) {
      return {
        message: { role: 'assistant', content: 'echo-llm: hello' },
        toolCalls: [],
        stopReason: 'stop',
      }
    },
  }),
}
```

**Security:** `mode` defaults to `worker`, so a service runs in the module's
child process next to its nodes and reaches the host only through the
capability broker — declared `fs`/`net` capabilities apply, and an approval
request from worker code is refused. `mode: 'host'` imports the service into
the host process and therefore requires `trusted: true`; that is the escape
hatch for code you are willing to run with full host reach. A legacy
declaration with `trusted: true` and no `mode` is a host service.

Run the example:

```sh
pnpm z1 module propose z1/examples/modules/echo-llm --modules-dir /tmp/z1-modules
pnpm z1 module approve com.example.echo-llm --modules-dir /tmp/z1-modules
pnpm z1 module list --modules-dir /tmp/z1-modules   # shows `services: llm(worker)`

pnpm z1 run --template agent.loop --message 'hello' \
  --json --db /tmp/z1-modules.db --modules-dir /tmp/z1-modules
```

The answer is `echo-llm: hello`. Precedence per run is
`overrides > approved service module > built-in default`; the highest module
version wins when several provide the same kind (ties keep the lower module
id, across both modes). Pass `--no-service-modules` (or `Z1_SERVICE_MODULES=0`,
or `"useServiceModules": false` in `z1.config.json`) to ignore all service
modules and fall back to the built-ins.
