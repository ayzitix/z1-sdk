// Nodes plus a declared service whose factory throws. Because the manifest
// declares the service and the grant approves it, the runtime loads services
// in the same child: the module's start must fail, naming the service.
export const nodes = [
  {
    id: 'com.example.bad-service.ping',
    version: '1.0.0',
    title: 'Ping',
    category: 'example',
    inputs: [],
    outputs: [{ kind: 'data', id: 'pong', schema: { type: 'boolean' } }],
    execute() {
      return { pong: true }
    },
  },
]

export const services = {
  llm() {
    throw new Error('bad-service factory exploded')
  },
}
