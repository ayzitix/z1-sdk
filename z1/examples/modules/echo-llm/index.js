// Trusted in-process service module. Unlike a node module this file runs in the
// host process, so it can reach the host directly; the approval is the boundary.
export const services = {
  llm(ctx) {
    ctx.log('info', 'echo-llm service started')
    return {
      async chat(request) {
        const messages = Array.isArray(request?.messages) ? request.messages : []
        let content = ''
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index]
          if (message?.role === 'user') {
            content = String(message.content ?? '')
            break
          }
        }
        return {
          message: { role: 'assistant', content: `echo-llm: ${content}` },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
      dispose() {
        ctx.log('info', 'echo-llm service disposed')
      },
    }
  },
}
