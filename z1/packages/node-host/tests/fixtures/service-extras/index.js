// Service-only module for the lifecycle, approval, capability and cancel
// tests. It deliberately exports NO `nodes`: a service-only module may omit
// them, and the host passes `loadServices: true` for it.
import { appendFile } from 'node:fs/promises'

// Module-scoped, so `status()` can report what `ctx.signal` did to an earlier
// call after the host has already dropped that call's result.
let aborted = false

export const services = {
  llm(ctx) {
    return {
      async approval(request) {
        return { decision: await ctx.approval.request(request) }
      },
      // Same call, but turns the host's refusal into a value the test can read.
      async tryApproval(request) {
        try {
          return { decision: await ctx.approval.request(request) }
        } catch (error) {
          return { error: String(error && error.message ? error.message : error) }
        }
      },
      async chat(provider) {
        const result = await ctx.llm.chat({
          model: { provider, model: 'mock-1' },
          messages: [{ role: 'user', content: 'hi' }],
        })
        return { text: result.message.content }
      },
      // Waits for the host to cancel this call, then records it.
      async watch() {
        const { signal } = ctx
        await new Promise((resolve) => {
          if (signal.aborted) {
            aborted = true
            resolve()
            return
          }
          signal.addEventListener(
            'abort',
            () => {
              aborted = true
              resolve()
            },
            { once: true },
          )
        })
        return { aborted: true }
      },
      status() {
        return { aborted }
      },
    }
  },

  tools(ctx) {
    return {
      async call(name) {
        return await ctx.tools.call(name, { x: 1 })
      },
    }
  },

  getter(ctx) {
    return {
      lookup(name) {
        return { found: ctx.get(name) !== undefined }
      },
    }
  },

  // Writes one line per dispose() call through plain node:fs, so nothing has
  // to cross IPC while the child is being torn down. The path arrives in the
  // host-provided environment.
  dispose() {
    return {
      async dispose() {
        const log = process.env.DISPOSE_LOG
        if (log === undefined || log.length === 0) return
        await appendFile(log, 'dispose\n', 'utf8')
      },
    }
  },

  'dispose-thrower'() {
    return {
      async dispose() {
        throw new Error('dispose exploded')
      },
    }
  },
}
