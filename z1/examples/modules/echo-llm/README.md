# Echo LLM service module

A **service module**: it declares no nodes and instead replaces the `llm`
ambient service for every run that loads it. `index.js` exports a `services`
map whose `llm` factory returns an object implementing `chat(request)`; the
answer echoes the last user message as `echo-llm: <text>`.

> This module uses `"mode": "worker"`, the default: the service runs in the
> module's child process next to its nodes, behind the capability broker. It
> cannot read files, reach the network or prompt for approval unless the
> manifest declares the capability. To run a service inside the host process
> instead, declare `"mode": "host", "trusted": true` — that is trusting its
> code with the whole host.

A worker entry must export `nodes` (empty is fine) for the child bootstrap:

```js
export const nodes = []
export const services = { llm: (ctx) => ({ async chat(request) { /* ... */ } }) }
```

```sh
z1 module propose z1/examples/modules/echo-llm --modules-dir /tmp/z1-modules
z1 module approve com.example.echo-llm --modules-dir /tmp/z1-modules
z1 module list --modules-dir /tmp/z1-modules   # shows `services: llm(worker)`

z1 run --template agent.loop --message 'hello' \
  --modules-dir /tmp/z1-modules --json
```

The run's answer starts with `echo-llm: hello`. Pass `--no-service-modules` to
ignore every service module and fall back to the built-in providers.
