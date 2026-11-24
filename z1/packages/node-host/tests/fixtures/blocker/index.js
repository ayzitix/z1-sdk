// One node that ignores cancellation on purpose.
//
// It spends its whole life inside `ctx.process.run`, which is the only shape
// that reproduces the cancel bug: `ctx.signal` cannot fire into a node that is
// blocked on a capability RPC, and the child the host spawned for it outlives
// the call. The child writes `child.pid` at once and a `sentinel` at +8 s,
// then idles, so only an external kill can stop that sentinel. `timeoutMs` is
// far beyond the test window, so the tool's own timeout cannot be the reason
// the child ends.
//
// Every input is a string because the worker's dynamic test modules do not set
// per-port schemas; the node coerces them.
import { join } from 'node:path'

export const nodes = [
  {
    id: 'com.example.blocker.node',
    version: '1.0.0',
    title: 'Blocker',
    category: 'example',
    inputs: [
      { kind: 'data', id: 'dir', schema: { type: 'string' }, required: true },
      { kind: 'data', id: 'sentinelAfterMs', schema: { type: 'string' }, required: true },
    ],
    outputs: [
      { kind: 'data', id: 'code', schema: { type: 'number' } },
      { kind: 'data', id: 'aborted', schema: { type: 'boolean' } },
    ],
    async execute(ctx) {
      const dir = String(ctx.inputs.dir)
      const after = Number(ctx.inputs.sentinelAfterMs)
      const script = [
        `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'child.pid'))}, String(process.pid))`,
        `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'sentinel'))}, 'x'), ${after})`,
        'setInterval(() => {}, 1000)',
      ].join(';')
      // No `ctx.signal`: the node is stuck in here until the host kills the
      // child, whatever the module would like to do about it.
      const result = await ctx.process.run({
        command: process.execPath,
        args: ['-e', script],
        timeoutMs: 60000,
      })
      return { code: result.code ?? -1, aborted: ctx.signal.aborted }
    },
  },
]

export const services = {
  // The service-side twin of the node above. A tools service in worker mode
  // (`com.z1.tools`) is exactly this shape: `call` runs a command through
  // `ctx.process.run` and never watches `ctx.signal`.
  blocker(ctx) {
    return {
      async block(dirRaw, sentinelAfterMsRaw) {
        const dir = String(dirRaw)
        const after = Number(sentinelAfterMsRaw)
        const script = [
          `require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'child.pid'))}, String(process.pid))`,
          `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(join(dir, 'sentinel'))}, 'x'), ${after})`,
          'setInterval(() => {}, 1000)',
        ].join(';')
        return await ctx.process.run({
          command: process.execPath,
          args: ['-e', script],
          timeoutMs: 60000,
        })
      },
    }
  },
}
