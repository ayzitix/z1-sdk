// Plain, dependency-free ESM module used by the node-host tests. It only
// touches `node:` builtins and the ctx proxies, exactly like a real module.
import { join } from 'node:path'

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
    // Starts a `process.run` child that survives on its own (writes `child.pid`
    // immediately, `sentinel` at +3 s, then idles). The node itself finishes at
    // once, so the child is in flight with no task holding it: only the host's
    // reaper can stop it. `process.run` reports no pid, so the test reads the
    // one the child wrote.
    id: 'com.example.echo.runner',
    version: '1.0.0',
    title: 'Runner',
    category: 'example',
    inputs: [{ kind: 'data', id: 'dir', schema: { type: 'string' }, required: true }],
    outputs: [{ kind: 'data', id: 'code', schema: { type: 'number' } }],
    async execute(ctx) {
      const dir = String(ctx.inputs.dir)
      const script = [
        `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'child.pid'))}, String(process.pid))`,
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'sentinel'))}, 'x'), 3000)`,
        'setInterval(() => {}, 1000)',
      ].join(';')
      // No `cwd`: it must stay inside the granted `fs.read` patterns, and the
      // temp dir the child writes into is not. The child writes by absolute
      // path, so its working directory does not matter.
      const result = await ctx.process.run({
        command: process.execPath,
        args: ['-e', script],
        // Far longer than the test window: only the reaper can end it early.
        timeoutMs: 60000,
      })
      // Disposed before the child finished: the run settles with a kill status.
      return { code: result.code ?? -1 }
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
    id: 'com.example.echo.tasker',
    version: '1.0.0',
    title: 'Tasker',
    category: 'example',
    inputs: [],
    outputs: [{ kind: 'data', id: 'value', schema: { type: 'string' } }],
    async execute(ctx) {
      const task = await ctx.process.start({
        command: process.execPath,
        args: ['-e', "console.log('task-output')"],
      })
      let snapshot = await ctx.process.poll({ id: task.id })
      const deadline = Date.now() + 5000
      // A poll returns only the bytes after the cursor, so accumulate: the line
      // can arrive on a poll whose status is still `running`, leaving the later
      // terminal snapshot empty.
      let text = snapshot.output
      while (snapshot.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        snapshot = await ctx.process.poll({ id: task.id, cursor: snapshot.cursor })
        text += snapshot.output
      }
      const tasks = await ctx.process.list()
      return { value: `${snapshot.status}|${text.trim()}|${tasks.length}` }
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
      { kind: 'data', id: 'url', schema: { type: 'string' } },
      { kind: 'data', id: 'body', schema: { type: 'string' } },
    ],
    async execute(ctx) {
      const response = await ctx.net.request({ url: String(ctx.inputs.url), method: 'GET' })
      return { status: response.status, url: response.url, body: response.body }
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
