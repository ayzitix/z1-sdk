// Dependency-free ESM entry for the example module. Only `node:` builtins and
// the `ctx` proxies are available: module code never imports the host.

export const nodes = [
  {
    id: 'com.example.echo.echo',
    version: '1.0.0',
    title: 'Echo',
    category: 'example',
    inputs: [{ kind: 'data', id: 'text', schema: { type: 'string' }, required: true }],
    outputs: [
      { kind: 'data', id: 'text', schema: { type: 'string' } },
      { kind: 'flow', id: 'out' },
    ],
    async execute(ctx) {
      const text = String(ctx.inputs.text ?? '')
      ctx.log('info', `echo received ${text.length} characters`)
      // A stream chunk is advisory: the final value is still the return below.
      ctx.emit('text', text)
      return { text: `${text}!`, out: true }
    },
  },
]
