# Echo LLM service module

A **service module**: it declares no nodes and instead replaces the `llm`
ambient service for every run that loads it. `index.js` exports a `services`
map whose `llm` factory returns an object implementing `chat(request)`; the
answer echoes the last user message as `echo-llm: <text>`.

> Service modules run **in-process**. They are not sandboxed like node workers,
> so approving one is trusting its code with the whole host. v1 only accepts
> manifests that declare `trusted: true`.

```sh
z1 module propose z1/examples/modules/echo-llm --modules-dir /tmp/z1-modules
z1 module approve com.example.echo-llm --modules-dir /tmp/z1-modules
z1 module list --modules-dir /tmp/z1-modules   # shows `services: llm`

z1 run --template agent.loop --message 'hello' \
  --modules-dir /tmp/z1-modules --json
```

The run's answer starts with `echo-llm: hello`. Pass `--no-service-modules` to
ignore every service module and fall back to the built-in providers.
