import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, test } from 'vitest'
import type { FsService, LlmService, ToolService } from '@z1/runtime'
import { ModuleWorker, type WorkerHostServices, type WorkerHostOptions } from '../src/index.ts'

const MODULE_DIR = fileURLToPath(new URL('./fixtures/echo', import.meta.url))
const FETCHER = 'com.example.echo.fetcher'
/** The fixture exports every node, so the manifest must declare them all. */
const NODE_IDS = [
  'com.example.echo.echo',
  'com.example.echo.reader',
  'com.example.echo.crasher',
  'com.example.echo.sleeper',
  'com.example.echo.llmer',
  'com.example.echo.modeller',
  'com.example.echo.tasker',
  'com.example.echo.denied',
  'com.example.echo.fetcher',
  'com.example.echo.subgrapher',
]

const workers: ModuleWorker[] = []

function services(): WorkerHostServices {
  const fs: FsService = {
    read: async () => {
      throw new Error('fs.read is not used by this fixture')
    },
    write: async () => {
      throw new Error('fs.write is not used by this fixture')
    },
  }
  const tools: ToolService = {
    call: async () => {
      throw new Error('unexpected tool call')
    },
    list: async () => [],
  }
  const llm: LlmService = {
    chat: async () => {
      throw new Error('unexpected llm call')
    },
  }
  return { fs, tools, llm, approval: { request: async () => 'allowed-once' } }
}

function workerWith(hosts: string[], overrides: Partial<WorkerHostOptions> = {}): ModuleWorker {
  const worker = new ModuleWorker({
    moduleDir: MODULE_DIR,
    entry: 'index.js',
    manifestNodeIds: NODE_IDS,
    capabilities: { net: { hosts } },
    services: services(),
    ...overrides,
  })
  workers.push(worker)
  return worker
}

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.dispose().catch(() => undefined)
})

interface Served {
  server: Server
  port: number
  url: string
  close: () => Promise<void>
}

/** Bind a throwaway server; `host` defaults to every interface so `localhost` works. */
async function serve(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  options: { host?: string } = {},
): Promise<Served> {
  const server = createServer(handler)
  await new Promise<void>((settle) => server.listen(0, options.host, settle))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('no server address')
  return {
    server,
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((settle) => server.close(() => settle())),
  }
}

async function fetchText(worker: ModuleWorker, url: string): Promise<Record<string, unknown>> {
  return worker.execute(FETCHER, {}, { url }, null)
}

describe('net.request SSRF guard', () => {
  test('an explicitly granted loopback host is reachable', async () => {
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('hello local')
    })
    try {
      const worker = workerWith(['127.0.0.1'])
      await worker.start()
      const outputs = await fetchText(worker, `${server.url}/`)
      expect(outputs['status']).toBe(200)
      expect(outputs['body']).toBe('hello local')
    } finally {
      await server.close()
    }
  }, 20_000)

  test('a wildcard grant does not reach loopback', async () => {
    let hits = 0
    const server = await serve((_request, response) => {
      hits += 1
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('INTERNAL-ONLY')
    })
    try {
      const worker = workerWith(['*'])
      await worker.start()
      await expect(fetchText(worker, `${server.url}/`)).rejects.toThrow(
        /capability denied for net\.request .*needs an explicit net\.hosts entry/,
      )
      expect(hits).toBe(0)
    } finally {
      await server.close()
    }
  }, 20_000)

  test('a redirect into loopback is denied even when the first hop is granted', async () => {
    // `*` makes the allowlist pass for 127.0.0.1, so only the address rule can
    // stop the hop. `localhost` is the explicit grant for the first hop.
    let secretHits = 0
    const secret = await serve((_request, response) => {
      secretHits += 1
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('SECRET')
    })
    const front = await serve((request, response) => {
      if (request.url === '/redir') {
        response.writeHead(302, { location: `${secret.url}/secret` })
        response.end()
        return
      }
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('front')
    })
    try {
      const worker = workerWith(['localhost', '*'])
      await worker.start()
      await expect(
        fetchText(worker, `http://localhost:${front.port}/redir`),
      ).rejects.toThrow(/capability denied for net\.request "127\.0\.0\.1".*explicit net\.hosts entry/)
      expect(secretHits).toBe(0)
    } finally {
      await front.close()
      await secret.close()
    }
  }, 20_000)

  test('a hostname granted by name may resolve to a LAN address', async () => {
    // `localhost` is the only way to be a private-resolving name without DNS
    // in a test: the grant is by name, the answer is a loopback address.
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end('via name')
    })
    try {
      const worker = workerWith(['localhost'])
      await worker.start()
      const outputs = await fetchText(worker, `http://localhost:${server.port}/`)
      expect(outputs['body']).toBe('via name')
    } finally {
      await server.close()
    }
  }, 20_000)
})

/** "Привет" in windows-1251 and "こんにちは" in Shift-JIS. */
const WINDOWS_1251_PRIVET = Uint8Array.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2])
const SHIFT_JIS_KONNICHIWA = Uint8Array.from([
  0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd,
])

async function bodyFrom(
  contentType: string,
  bytes: Uint8Array,
): Promise<string> {
  const server = await serve((_request, response) => {
    response.writeHead(200, { 'content-type': contentType })
    response.end(Buffer.from(bytes))
  })
  try {
    const worker = workerWith(['127.0.0.1'])
    await worker.start()
    const outputs = await fetchText(worker, `${server.url}/`)
    expect(outputs['status']).toBe(200)
    return String(outputs['body'])
  } finally {
    await server.close()
  }
}

describe('net.request charset handling', () => {
  test('honours Content-Type charset', async () => {
    const body = await bodyFrom('text/html; charset=windows-1251', WINDOWS_1251_PRIVET)
    expect(body).toBe('Привет')
  }, 20_000)

  test('sniffs <meta charset> when the header has none', async () => {
    const html = Buffer.concat([
      Buffer.from('<html><head><meta charset="windows-1251"></head><body>'),
      Buffer.from(WINDOWS_1251_PRIVET),
      Buffer.from('</body></html>'),
    ])
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(html)
    })
    try {
      const worker = workerWith(['127.0.0.1'])
      await worker.start()
      const outputs = await fetchText(worker, `${server.url}/`)
      expect(String(outputs['body'])).toContain('Привет')
    } finally {
      await server.close()
    }
  }, 20_000)

  test('sniffs <meta http-equiv content="...charset=...">', async () => {
    const html = Buffer.concat([
      Buffer.from(
        '<html><head><meta http-equiv="content-type" content="text/html; charset=windows-1251"></head><body>',
      ),
      Buffer.from(WINDOWS_1251_PRIVET),
      Buffer.from('</body></html>'),
    ])
    const server = await serve((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(html)
    })
    try {
      const worker = workerWith(['127.0.0.1'])
      await worker.start()
      const outputs = await fetchText(worker, `${server.url}/`)
      expect(String(outputs['body'])).toContain('Привет')
    } finally {
      await server.close()
    }
  }, 20_000)

  test('decodes Shift-JIS', async () => {
    const body = await bodyFrom('text/html; charset=shift_jis', SHIFT_JIS_KONNICHIWA)
    expect(body).toBe('こんにちは')
  }, 20_000)

  test('falls back to UTF-8 on an unknown charset label', async () => {
    const body = await bodyFrom('text/html; charset=not-a-real-charset', Buffer.from('café'))
    expect(body).toBe('café')
  }, 20_000)

  test('drops a UTF-8 BOM', async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('plain')])
    const body = await bodyFrom('text/plain; charset=utf-8', bytes)
    expect(body).toBe('plain')
  }, 20_000)

  test('keeps non-UTF-8 binary-ish bodies as a string', async () => {
    const body = await bodyFrom('application/octet-stream', Uint8Array.from([0x00, 0xff, 0x41]))
    expect(typeof body).toBe('string')
    expect(body.length).toBeGreaterThan(0)
  }, 20_000)
})
