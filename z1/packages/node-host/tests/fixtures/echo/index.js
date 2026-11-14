// Plain, dependency-free ESM module used by the node-host tests. It only
// touches `node:` builtins and the ctx proxies, exactly like a real module.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      ctx.log('info', 'echo started')
      ctx.emit('text', 'partial')
      await delay(10)
      const text = String(ctx.inputs.text)
      return { text, out: true }
    },
  },
  {
    id: 'com.example.echo.reader',
    version: '1.0.0',
    title: 'Reader',
    category: 'example',
    inputs: [{ kind: 'data', id: 'path', schema: { type: 'string' }, required: true }],
    outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],
    async execute(ctx) {
      const text = await ctx.fs.read(ctx.inputs.path)
      return { text }
    },
  },
  {
    id: 'com.example.echo.crasher',
    version: '1.0.0',
    title: 'Crasher',
    category: 'example',
    inputs: [],
    outputs: [],
    execute() {
      process.exit(1)
    },
  },
  {
    id: 'com.example.echo.sleeper',
    version: '1.0.0',
    title: 'Sleeper',
    category: 'example',
    inputs: [],
    outputs: [],
    async execute() {
      await delay(5000)
      return {}
    },
  },
  {
    id: 'com.example.echo.llmer',
    version: '1.0.0',
    title: 'Llmer',
    category: 'example',
    inputs: [{ kind: 'data', id: 'prompt', schema: { type: 'string' }, required: true }],
    outputs: [
      { kind: 'data', id: 'text', schema: { type: 'string' } },
      { kind: 'data', id: 'deltas', schema: { type: 'array' } },
    ],
    async execute(ctx) {
      const deltas = []
      const result = await ctx.llm.chat(
        {
          model: { provider: 'stub', model: 'stub-1' },
          messages: [{ role: 'user', content: String(ctx.inputs.prompt) }],
        },
        (delta) => {
          deltas.push(delta)
        },
      )
      return { text: result.message.content, deltas }
    },
  },
  {
    id: 'com.example.echo.modeller',
    version: '1.0.0',
    title: 'Modeller',
    category: 'example',
    inputs: [{ kind: 'data', id: 'provider', schema: { type: 'string' }, required: true }],
    outputs: [{ kind: 'data', id: 'ids', schema: { type: 'array' } }],
    async execute(ctx) {
      const response = await ctx.llm.get({
        provider: String(ctx.inputs.provider),
        path: '/models',
      })
      return { ids: response.body }
    },
  },
  {
    id: 'com.example.echo.denied',
    version: '1.0.0',
    title: 'Denied',
    category: 'example',
    inputs: [],
    outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],
    async execute(ctx) {
      const text = await ctx.fs.read('/etc/passwd')
      return { text }
    },
  },
  {
    id: 'com.example.echo.fetcher',
    version: '1.0.0',
    title: 'Fetcher',
    category: 'example',
    inputs: [{ kind: 'data', id: 'url', schema: { type: 'string' }, required: true }],
    outputs: [
      { kind: 'data', id: 'status', schema: { type: 'number' } },
      { kind: 'data', id: 'body', schema: { type: 'string' } },
    ],
    async execute(ctx) {
      const response = await ctx.net.request({ url: String(ctx.inputs.url), method: 'GET' })
      return { status: response.status, body: response.body }
    },
  },
  {
    id: 'com.example.echo.subgrapher',
    version: '1.0.0',
    title: 'Subgrapher',
    category: 'example',
    inputs: [],
    outputs: [],
    async execute(ctx) {
      ctx.runSubgraph()
    },
  },
]
