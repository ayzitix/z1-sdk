import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import { startServer, type Z1Server } from '../src/index.ts'

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div></body></html>'

const servers: Z1Server[] = []
const directories: string[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close()
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

/** A build-shaped directory: index.html plus one hashed asset. */
async function makeBuild(): Promise<{ root: string; staticDir: string }> {
  const root = await mkdtemp(join(tmpdir(), 'z1-static-'))
  directories.push(root)
  const staticDir = join(root, 'dist')
  await mkdir(join(staticDir, 'assets'), { recursive: true })
  await writeFile(join(staticDir, 'index.html'), INDEX_HTML)
  await writeFile(join(staticDir, 'assets', 'app.js'), 'console.log("z1")\n')
  // Sits next to the build, not inside it: a traversal must not reach it.
  await writeFile(join(root, 'secret'), 'top secret\n')
  return { root, staticDir }
}

async function start(staticDir: string): Promise<Z1Server> {
  const server = await startServer({
    dbPath: join(staticDir, '..', 'runs.db'),
    port: 0,
    staticDir,
  })
  servers.push(server)
  return server
}

function origin(server: Z1Server): string {
  return `http://127.0.0.1:${String(server.port)}`
}

/** Raw request: `fetch` normalises dot segments before they reach the server. */
function rawGet(server: Z1Server, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port: server.port, method: 'GET', path },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          body += chunk
        })
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, body })
        })
      },
    )
    req.on('error', reject)
    req.end()
  })
}

test('serves index.html at / with an html content type', async () => {
  const { staticDir } = await makeBuild()
  const server = await start(staticDir)

  const response = await fetch(`${origin(server)}/`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/html')
  expect(await response.text()).toContain('<div id="root">')
})

test('serves nested assets with the right content type', async () => {
  const { staticDir } = await makeBuild()
  const server = await start(staticDir)

  const response = await fetch(`${origin(server)}/assets/app.js`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('javascript')
  expect(await response.text()).toContain('console.log')
})

test('an extension-less route falls back to index.html', async () => {
  const { staticDir } = await makeBuild()
  const server = await start(staticDir)

  const response = await fetch(`${origin(server)}/some/route`)
  expect(response.status).toBe(200)
  expect(response.headers.get('content-type')).toContain('text/html')
  expect(await response.text()).toContain('<div id="root">')
})

test('a missing file is a 404, not the SPA fallback', async () => {
  const { staticDir } = await makeBuild()
  const server = await start(staticDir)

  const response = await fetch(`${origin(server)}/missing.js`)
  expect(response.status).toBe(404)
})

test('a traversal attempt is refused', async () => {
  const { staticDir } = await makeBuild()
  const server = await start(staticDir)

  // Percent-encoded dots and literal dots both reach the handler as `..`.
  for (const path of ['/../secret', '/%2e%2e/secret', '/assets/%2e%2e/%2e%2e/secret']) {
    const response = await rawGet(server, path)
    expect(response.status).toBe(404)
    expect(response.body).not.toContain('top secret')
  }
})

test('never lists a directory', async () => {
  const { staticDir } = await makeBuild()
  const server = await start(staticDir)

  const response = await fetch(`${origin(server)}/assets/`)
  // `/assets/` is a directory: neither a listing nor a file, so no 200 body
  // with file names in it.
  const text = await response.text()
  expect(text).not.toContain('app.js')
})
