// Dependency-free service-only module used by the service RPC tests.
// It exports no nodes, so `ready` must still carry its services.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const nodes = []

export const services = {
  llm() {
    return {
      async chat(request, onDelta) {
        const last = request.messages.at(-1)?.content ?? ''
        onDelta?.({ type: 'text', text: 'svc-a' })
        onDelta?.({ type: 'text', text: 'svc-b' })
        return {
          message: { role: 'assistant', content: 'svc: ' + last },
          toolCalls: [],
          stopReason: 'stop',
        }
      },
    }
  },

  tools() {
    return {
      async call(name, args) {
        return { ok: true, name, args }
      },
      async list() {
        return []
      },
    }
  },

  fs() {
    return {
      async read() {
        throw new Error('not implemented')
      },
      async write() {
        // no-op
      },
    }
  },

  pid() {
    return {
      get() {
        return { pid: process.pid }
      },
    }
  },

  crasher() {
    return {
      boom() {
        throw new Error('boom from service')
      },
    }
  },

  slow() {
    return {
      async wait() {
        await delay(5_000)
        return { finished: true }
      },
    }
  },

  // In-memory fs with real behaviour, so the adapter can be tested positively
  // without changing `fs` (which exists to prove host-side denials).
  'echo-fs'() {
    const files = new Map()
    return {
      async read(path) {
        if (!files.has(path)) throw new Error('no such file: ' + path)
        return files.get(path)
      },
      async write(path, data) {
        files.set(path, String(data))
      },
    }
  },

  // Bytes travel as base64; the returned hash is opaque to the host.
  artifacts() {
    const blobs = new Map()
    let sequence = 0
    return {
      async put({ data, mime }) {
        sequence += 1
        const hash = 'artifact-' + String(sequence)
        blobs.set(hash, { data, mime })
        return { hash, mime }
      },
      async get({ hash }) {
        const stored = blobs.get(hash)
        if (stored === undefined) throw new Error('no artifact: ' + hash)
        return stored
      },
    }
  },

  memory() {
    return {
      async buildContext(request) {
        return {
          text: 'mem:' + request.runId,
          messages: [{ role: 'system', content: 'remember' }],
          spine: ['run'],
          siblings: [],
          recent: [{ path: 'a', type: 'node', summary: 'did it' }],
        }
      },
    }
  },

  // Emits a malformed delta and omits the message content.
  bad() {
    return {
      async chat(request, onDelta) {
        onDelta?.({ type: 'bogus', text: 'x' })
        return { message: { role: 'assistant' }, toolCalls: [], stopReason: 'stop' }
      },
    }
  },

  // Well-formed delta stream, malformed final answer.
  'bad-llm'() {
    return {
      async chat(request, onDelta) {
        onDelta?.({ type: 'text', text: 'ok' })
        return { message: { role: 'assistant' }, toolCalls: [], stopReason: 'stop' }
      },
    }
  },
}
