/**
 * Serves a built canvas (`apps/canvas/dist`) from the server's HTTP port.
 *
 * The WebSocket endpoint is reserved: `/ws` is answered by the upgrade path, so
 * a plain HTTP request for it is a 404 rather than a page. Everything else is
 * resolved inside the build directory, and any request that would escape it is
 * refused by path containment rather than by string matching.
 *
 * @module @z1/server/static
 */

import { readFile, stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { extname, resolve, sep } from 'node:path'

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.gif': 'image/gif',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}

/** Content type for a file name; unknown extensions are opaque bytes. */
export function contentTypeFor(file: string): string {
  return CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
}

function plain(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
  })
  response.end(body)
}

/** `undefined` when the file is missing or is not a regular file. */
async function existingFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path)
    return info.isFile() ? path : undefined
  } catch {
    return undefined
  }
}

async function sendFile(
  file: string,
  response: ServerResponse,
  includeBody: boolean,
): Promise<void> {
  const body = await readFile(file)
  response.writeHead(200, {
    'content-type': contentTypeFor(file),
    'content-length': String(body.byteLength),
  })
  response.end(includeBody ? body : undefined)
}

/** `/a/../b` and `/%2e%2e/b` must both stay inside `base`. */
function containedRelative(base: string, pathname: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const relative = decoded.startsWith('/') ? decoded.slice(1) : decoded
  const target = resolve(base, relative)
  if (target !== base && !target.startsWith(base + sep)) return undefined
  return target
}

/**
 * `GET /` and extension-less misses fall back to `index.html` so client routes
 * survive a reload; a miss that names a file (`/missing.js`) is a 404 and a
 * directory is never listed.
 */
export function createStaticHandler(
  root: string,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const base = resolve(root)
  return async (request, response): Promise<void> => {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      plain(response, 405, 'method not allowed\n')
      return
    }

    // Deliberately not `new URL(...)`: WHATWG parsing collapses `..` and `%2e`
    // segments *before* containment could see them, which would turn a
    // traversal attempt into a harmless client route. The raw target keeps the
    // dots, so an escape is refused rather than normalised away.
    const raw = request.url ?? '/'
    const query = raw.indexOf('?')
    const pathname = query === -1 ? raw : raw.slice(0, query)

    const target = containedRelative(base, pathname)
    if (target === undefined) {
      plain(response, 404, 'not found\n')
      return
    }

    const file = target === base ? undefined : await existingFile(target)
    if (file !== undefined) {
      await sendFile(file, response, method === 'GET')
      return
    }

    // A named file that does not exist is a genuine miss, not a client route.
    if (extname(pathname) !== '') {
      plain(response, 404, 'not found\n')
      return
    }

    const index = await existingFile(resolve(base, 'index.html'))
    if (index === undefined) {
      plain(response, 404, 'not found\n')
      return
    }
    await sendFile(index, response, method === 'GET')
  }
}
