// A service-only module: it exports no `nodes`, so the runtime must still
// spawn exactly one child for the llm service and expose it through
// `servicesFor()`.
//
// `chat` calls the host llm first, so a successful call also proves the
// service's capability grant arrived.
export const services = {
  llm(ctx) {
    return {
      async chat(request) {
        await ctx.llm.chat(request)
        return {
          message: { role: 'assistant', content: String(process.pid) },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },
}
