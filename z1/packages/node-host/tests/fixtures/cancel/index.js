// One slow node, used to prove that cancelling one execution of a module does
// not touch another execution hosted by the same child process.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const nodes = [
  {
    id: 'com.example.cancel.delay',
    version: '1.0.0',
    title: 'Delay',
    category: 'example',
    inputs: [{ kind: 'data', id: 'ms', schema: { type: 'number' }, required: true }],
    outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],
    async execute(ctx) {
      await delay(Number(ctx.inputs.ms))
      return { text: 'done' }
    },
  },
]
