// A node module whose service factory is designed to explode. A node-only
// worker (`loadServices: false`) must never call it.
export const nodes = [
  {
    id: 'com.example.node-bad.ping',
    version: '1.0.0',
    title: 'Ping',
    category: 'example',
    inputs: [],
    outputs: [{ kind: 'data', id: 'pong', schema: { type: 'boolean' } }],
    execute(ctx) {
      ctx.log('info', 'ping started')
      return { pong: true }
    },
  },
]

export const services = {
  llm() {
    throw new Error('service factory must not run in a node-only worker')
  },
}
