// A module with both a node and a worker-mode service. Both must run in the
// SAME child: the node and the llm service report `process.pid`, and the
// runtime test compares them.
//
// The manifest declares no capabilities; the tests grant `llm` instead, so a
// successful `ctx.llm.chat` proves the worker got its capabilities from the
// grant rather than from the manifest.
export const nodes = [
  {
    id: 'com.example.unified.pid',
    version: '1.0.0',
    title: 'Pid',
    category: 'example',
    inputs: [],
    outputs: [{ kind: 'data', id: 'pid', schema: { type: 'string' } }],
    execute() {
      return { pid: String(process.pid) }
    },
  },
]

export const services = {
  llm(ctx) {
    return {
      async chat(request) {
        // Round-trip through the host: this is the capability gate, and it
        // fails loudly if the grant did not reach this child.
        await ctx.llm.chat(request)
        return {
          message: { role: 'assistant', content: String(process.pid) },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      // Observable through the host's onLog hook: the runtime's dispose must
      // run this before the child is killed.
      async dispose() {
        ctx.log('info', 'unified-llm-dispose')
      },
    }
  },
}
