// Plain, dependency-free ESM fixture for the brokered fs.list / process.run
// capability tests. It only touches `node:` builtins through the ctx proxies.
export const nodes = [
  {
    id: 'com.example.caps.list',
    version: '1.0.0',
    title: 'List',
    category: 'example',
    inputs: [{ kind: 'data', id: 'path', schema: { type: 'string' }, required: true }],
    outputs: [
      { kind: 'data', id: 'path', schema: { type: 'string' } },
      { kind: 'data', id: 'entries', schema: { type: 'array' } },
    ],
    async execute(ctx) {
      return await ctx.fs.list(String(ctx.inputs.path))
    },
  },
  {
    id: 'com.example.caps.run',
    version: '1.0.0',
    title: 'Run',
    category: 'example',
    inputs: [
      { kind: 'data', id: 'command', schema: { type: 'string' }, required: true },
      { kind: 'data', id: 'args', schema: { type: 'array' } },
      { kind: 'data', id: 'cwd', schema: { type: 'string' } },
      { kind: 'data', id: 'timeoutMs', schema: { type: 'number' } },
      { kind: 'data', id: 'maxOutputBytes', schema: { type: 'number' } },
      { kind: 'data', id: 'env', schema: { type: 'object' } },
    ],
    outputs: [
      { kind: 'data', id: 'code', schema: { type: ['number', 'null'] } },
      { kind: 'data', id: 'signal', schema: { type: ['string', 'null'] } },
      { kind: 'data', id: 'stdout', schema: { type: 'string' } },
      { kind: 'data', id: 'stderr', schema: { type: 'string' } },
      { kind: 'data', id: 'truncated', schema: { type: 'boolean' } },
      { kind: 'data', id: 'durationMs', schema: { type: 'number' } },
    ],
    async execute(ctx) {
      const request = { command: String(ctx.inputs.command) }
      const args = ctx.inputs.args
      if (Array.isArray(args)) request.args = args.map((entry) => String(entry))
      if (typeof ctx.inputs.cwd === 'string') request.cwd = ctx.inputs.cwd
      if (typeof ctx.inputs.timeoutMs === 'number') request.timeoutMs = ctx.inputs.timeoutMs
      if (typeof ctx.inputs.maxOutputBytes === 'number') {
        request.maxOutputBytes = ctx.inputs.maxOutputBytes
      }
      if (ctx.inputs.env !== null && typeof ctx.inputs.env === 'object') {
        request.env = ctx.inputs.env
      }
      return await ctx.process.run(request)
    },
  },
]
