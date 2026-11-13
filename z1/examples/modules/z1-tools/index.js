/**
 * `com.z1.tools` — filesystem, shell and HTTP tools for z1 workers.
 *
 * A dependency-free ESM module with one `tools` service. Every method runs in
 * the module worker and reaches the real world only through the host's
 * capability broker (`ctx.fs`, `ctx.process`, `ctx.net`), so the manifest grant
 * stays the single place that decides what the tools may touch.
 *
 * Reads (`read`, `list`, `glob`) never ask for approval: they are bounded and
 * non-mutating. `write`, `edit`, `shell` and `http` ask the run's approval
 * channel first and proceed only on `allowed-once`.
 *
 * @module com.z1.tools
 */

import { isAbsolute, relative, resolve, sep } from 'node:path'

/** Lines returned by `read` when the caller does not ask for a window. */
const DEFAULT_READ_LIMIT = 2000
/** Largest file `read` will load through the broker. */
const MAX_READ_BYTES = 1024 * 1024
/** Deepest recursion accepted by `list` and `glob`. */
const MAX_DEPTH = 8
/** Most entries `list`/`glob` will collect before reporting truncation. */
const MAX_ENTRIES = 5000
/** Default `process.run` timeout; the manifest limit is 120_000 ms. */
const DEFAULT_SHELL_TIMEOUT_MS = 30_000
const MAX_SHELL_TIMEOUT_MS = 120_000

const TOOL_SCHEMAS = [
  {
    name: 'read',
    description:
      'Read a UTF-8 text file. `offset` is a 1-based line number, `limit` defaults to 2000 lines, and files over 1 MiB are refused.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path, or relative to the workspace.' },
        offset: { type: 'integer', minimum: 1, description: 'First line to return (1-based).' },
        limit: { type: 'integer', minimum: 1, description: 'Maximum number of lines to return.' },
      },
    },
  },
  {
    name: 'write',
    description: 'Write a UTF-8 text file, creating parent directories. Asks for approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'content'],
      properties: {
        path: { type: 'string', description: 'Absolute path, or relative to the workspace.' },
        content: { type: 'string', description: 'Full file content.' },
      },
    },
  },
  {
    name: 'edit',
    description:
      'Replace `oldText` in a text file. `oldText` must occur exactly once unless `replaceAll` is true. Asks for approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'oldText', 'newText'],
      properties: {
        path: { type: 'string', description: 'Absolute path, or relative to the workspace.' },
        oldText: { type: 'string', description: 'Exact text to replace; must be non-empty.' },
        newText: { type: 'string', description: 'Replacement text.' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence.' },
      },
    },
  },
  {
    name: 'list',
    description: 'List a directory through the host. Recursion is bounded to 8 levels and 5000 entries.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['path'],
      properties: {
        path: { type: 'string', description: 'Absolute path, or relative to the workspace.' },
        recursive: { type: 'boolean', description: 'Walk subdirectories.' },
        maxDepth: { type: 'integer', minimum: 1, maximum: 8, description: 'Recursion depth.' },
      },
    },
  },
  {
    name: 'glob',
    description:
      'Find files by glob (`*`, `**`, `?`) under an optional root. Returns absolute paths.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['pattern'],
      properties: {
        pattern: { type: 'string', description: 'Glob matched against the path relative to the root.' },
        path: { type: 'string', description: 'Root directory; defaults to the workspace.' },
      },
    },
  },
  {
    name: 'shell',
    description:
      'Run a command without a shell string, with a timeout. Working directory defaults to the workspace. Asks for approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: { type: 'string', description: 'Executable, resolved on PATH.' },
        args: { type: 'array', items: { type: 'string' }, description: 'Argument vector.' },
        cwd: { type: 'string', description: 'Working directory; defaults to the workspace.' },
        timeoutMs: { type: 'integer', minimum: 1, maximum: 120000 },
      },
    },
  },
  {
    name: 'http',
    description: 'Perform an HTTP(S) request and return the status, headers and body. Asks for approval.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL.' },
        method: { type: 'string', description: 'HTTP method; defaults to GET.' },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Request headers.',
        },
        body: { type: 'string', description: 'Request body.' },
      },
    },
  },
]

function fail(message) {
  throw new Error(message)
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readArgs(raw, tool) {
  if (raw === undefined || raw === null) return {}
  if (!isRecord(raw)) fail(`${tool} expects an object of arguments`)
  return raw
}

function stringArg(raw, key, tool) {
  const value = raw[key]
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${tool}.${key} must be a non-empty string`)
  }
  return value
}

function optionalBoolean(raw, key, tool) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(`${tool}.${key} must be a boolean`)
  return value
}

function positiveInteger(raw, key, tool, max) {
  const value = raw[key]
  if (value === undefined) return undefined
  if (!Number.isInteger(value) || value < 1) fail(`${tool}.${key} must be a positive integer`)
  if (max !== undefined && value > max) fail(`${tool}.${key} must be at most ${max}`)
  return value
}

/** Absolute paths pass through; relative ones resolve against the workspace. */
function workspacePath(ctx, value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(`${field} must be a non-empty path string`)
  }
  return isAbsolute(value) ? resolve(value) : resolve(ctx.workspace, value)
}

function posix(path) {
  return path.split(sep).join('/')
}

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Ask the run's approval channel before a mutating or outbound tool call.
 *
 * A worker service approval is enforced by the host, which *throws*
 * `approval was <decision> for run "…"` instead of returning the decision.
 * Both paths are normalised to the documented `approval <decision>`.
 */
async function approve(ctx, action, target, preview) {
  let decision
  try {
    decision = await ctx.approval.request({ action, target, preview })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const match = /^approval was (\S+)/.exec(message)
    fail(match === null ? message : `approval ${match[1]}`)
  }
  if (decision !== 'allowed-once') fail(`approval ${decision}`)
}

/* ------------------------------------------------------------------ read */

async function readTool(ctx, raw) {
  const path = workspacePath(ctx, raw['path'], 'read.path')
  const offset = positiveInteger(raw, 'offset', 'read') ?? 1
  const limit = positiveInteger(raw, 'limit', 'read') ?? DEFAULT_READ_LIMIT

  const text = await ctx.fs.read(path)
  const bytes = byteLength(text)
  if (bytes > MAX_READ_BYTES) {
    fail(
      `read: "${path}" is ${bytes} bytes, over the ${MAX_READ_BYTES}-byte limit; read it in pieces`,
    )
  }

  // Keep the original line endings so a full read reproduces the file exactly.
  const lines = text.match(/[^\n]*\n|[^\n]+/g) ?? []
  const start = offset - 1
  const selected = lines.slice(start, start + limit)

  return {
    path,
    content: selected.join(''),
    offset,
    limit,
    totalLines: lines.length,
    truncated: start + selected.length < lines.length,
  }
}

/* ----------------------------------------------------------------- write */

async function writeTool(ctx, raw) {
  const path = workspacePath(ctx, raw['path'], 'write.path')
  const content = raw['content']
  if (typeof content !== 'string') fail('write.content must be a string')
  const bytes = byteLength(content)

  await approve(ctx, 'tool.write', path, { path, bytes })
  await ctx.fs.write(path, content)
  return { path, bytes }
}

/* ------------------------------------------------------------------ edit */

function countOccurrences(text, needle) {
  let count = 0
  let index = 0
  for (;;) {
    const at = text.indexOf(needle, index)
    if (at < 0) return count
    count += 1
    index = at + needle.length
  }
}

async function editTool(ctx, raw) {
  const path = workspacePath(ctx, raw['path'], 'edit.path')
  const oldText = stringArg(raw, 'oldText', 'edit')
  const newText = raw['newText']
  if (typeof newText !== 'string') fail('edit.newText must be a string')
  const replaceAll = optionalBoolean(raw, 'replaceAll', 'edit') === true

  const before = await ctx.fs.read(path)
  const found = countOccurrences(before, oldText)
  if (found === 0) fail(`edit: "${oldText}" does not occur in ${path}`)
  if (found > 1 && !replaceAll) {
    fail(`edit: "${oldText}" occurs ${found} times in ${path}; pass replaceAll to replace every one`)
  }

  const after = replaceAll
    ? before.split(oldText).join(newText)
    : before.slice(0, before.indexOf(oldText)) + newText + before.slice(before.indexOf(oldText) + oldText.length)

  await approve(ctx, 'tool.edit', path, { path, replacements: found })
  await ctx.fs.write(path, after)
  return { path, replacements: found }
}

/* ------------------------------------------------------------------ list */

/**
 * Walk a directory tree through `ctx.fs.list`, breadth first, staying inside
 * the depth and entry budgets. Returns the collected entries and a flag.
 */
async function walk(ctx, base, maxDepth) {
  const entries = []
  const queue = [{ directory: base, depth: 1 }]
  let truncated = false

  while (queue.length > 0) {
    const { directory, depth } = queue.shift()
    const listed = await ctx.fs.list(directory)
    const found = Array.isArray(listed.entries) ? listed.entries : []
    for (const entry of found) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true
        break
      }
      entries.push({
        name: entry.name,
        path: entry.path,
        type: entry.type,
        depth,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      })
      if (entry.type === 'dir' && depth < maxDepth) {
        queue.push({ directory: entry.path, depth: depth + 1 })
      }
    }
    if (truncated) break
  }

  return { entries, truncated }
}

async function listTool(ctx, raw) {
  const base = workspacePath(ctx, raw['path'], 'list.path')
  const recursive = optionalBoolean(raw, 'recursive', 'list') === true
  const maxDepth = positiveInteger(raw, 'maxDepth', 'list', MAX_DEPTH) ?? (recursive ? MAX_DEPTH : 1)

  const { entries, truncated } = await walk(ctx, base, maxDepth)
  return { path: base, entries, truncated }
}

/* ------------------------------------------------------------------ glob */

function escapeRegex(character) {
  return /[\\^$.*+?()[\]{}|/]/.test(character) ? `\\${character}` : character
}

/** Anchored glob: `**` crosses `/`, `*` and `?` do not. */
function globToRegExp(pattern) {
  let source = '^'
  let index = 0
  while (index < pattern.length) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 2
        if (pattern[index] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        index += 1
        source += '[^/]*'
      }
      continue
    }
    if (character === '?') {
      index += 1
      source += '[^/]'
      continue
    }
    source += escapeRegex(character)
    index += 1
  }
  return new RegExp(`${source}$`)
}

async function globTool(ctx, raw) {
  let pattern = stringArg(raw, 'pattern', 'glob')
  if (pattern.startsWith('./')) pattern = pattern.slice(2)
  const base =
    raw['path'] === undefined
      ? resolve(ctx.workspace)
      : workspacePath(ctx, raw['path'], 'glob.path')
  const matcher = globToRegExp(pattern)

  const { entries, truncated } = await walk(ctx, base, MAX_DEPTH)
  const matches = []
  for (const entry of entries) {
    if (entry.type === 'dir') continue
    const rel = posix(relative(base, entry.path))
    if (matcher.test(rel) || matcher.test(posix(entry.path))) matches.push(entry.path)
  }
  matches.sort()

  return { matches, truncated }
}

/* ----------------------------------------------------------------- shell */

async function shellTool(ctx, raw) {
  const command = stringArg(raw, 'command', 'shell')
  const args = raw['args']
  if (args !== undefined) {
    if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
      fail('shell.args must be an array of strings')
    }
  }
  const cwd =
    raw['cwd'] === undefined ? resolve(ctx.workspace) : workspacePath(ctx, raw['cwd'], 'shell.cwd')
  const timeoutMs =
    positiveInteger(raw, 'timeoutMs', 'shell', MAX_SHELL_TIMEOUT_MS) ?? DEFAULT_SHELL_TIMEOUT_MS

  await approve(ctx, 'tool.shell', command, {
    command,
    args: args ?? [],
    cwd,
    timeoutMs,
  })
  return await ctx.process.run({ command, args: args ?? [], cwd, timeoutMs })
}

/* ------------------------------------------------------------------ http */

function httpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) fail('http.url must be a non-empty string')
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    fail(`http.url is not a valid URL: ${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    fail(`http.url must be http(s), not "${parsed.protocol}"`)
  }
  return parsed.href
}

async function httpTool(ctx, raw) {
  const url = httpUrl(raw['url'])
  const method = raw['method'] === undefined ? 'GET' : stringArg(raw, 'method', 'http').toUpperCase()
  const body = raw['body']
  if (body !== undefined && typeof body !== 'string') fail('http.body must be a string')

  const headers = {}
  if (raw['headers'] !== undefined) {
    if (!isRecord(raw['headers'])) fail('http.headers must be an object of strings')
    for (const [key, value] of Object.entries(raw['headers'])) {
      if (typeof value !== 'string') fail(`http.headers.${key} must be a string`)
      headers[key] = value
    }
  }

  await approve(ctx, 'tool.http', url, {
    method,
    url,
    ...(body === undefined ? {} : { bodyBytes: byteLength(body) }),
  })

  const request = { url, method, headers }
  if (body !== undefined) request.body = body
  return await ctx.net.request(request)
}

/* ---------------------------------------------------------------- tables */

const HANDLERS = {
  read: readTool,
  write: writeTool,
  edit: editTool,
  list: listTool,
  glob: globTool,
  shell: shellTool,
  http: httpTool,
}

export const services = {
  tools: (ctx) => ({
    /** Every tool this service exposes, with its JSON Schema. */
    list() {
      return TOOL_SCHEMAS
    },

    /** Run one tool. Unknown names and bad arguments throw a plain Error. */
    async call(name, args) {
      if (typeof name !== 'string' || name.length === 0) fail('tool name must be a non-empty string')
      const handler = HANDLERS[name]
      if (handler === undefined) fail(`unknown tool "${name}"`)
      return await handler(ctx, readArgs(args, name))
    },
  }),
}
