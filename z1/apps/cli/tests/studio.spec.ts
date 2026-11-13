import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { afterEach, expect, test } from 'vitest'

import { resolveCanvasDist } from '../src/cli.ts'

const BIN = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
/** The `z1` workspace root, so the canvas build resolves from the real layout. */
const Z1_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
const TSX = fileURLToPath(new URL('../../../node_modules/.bin/tsx', import.meta.url))
const TIMEOUT_MS = 20_000
const HAS_CANVAS_BUILD = resolveCanvasDist() !== undefined

interface StudioInfo {
  url: string
  ws: string
  token: string
  port: number
}

const children: ChildProcessWithoutNullStreams[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true })
  }
})

async function tempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  directories.push(directory)
  return directory
}

test('resolveCanvasDist finds a build beside the module', async () => {
  const root = await tempDir('z1-studio-resolve-')
  const dist = join(root, 'apps', 'canvas', 'dist')
  const moduleDirectory = join(root, 'apps', 'cli', 'src')
  await mkdir(dist, { recursive: true })
  await mkdir(moduleDirectory, { recursive: true })
  await writeFile(join(dist, 'index.html'), '<div id="root"></div>')

  const base = pathToFileURL(join(moduleDirectory, 'cli.ts'))
  expect(resolveCanvasDist(base)).toBe(dist)
})

test('resolveCanvasDist returns undefined without a build', async () => {
  const empty = await tempDir('z1-studio-empty-')
  expect(resolveCanvasDist(pathToFileURL(join(empty, 'cli.ts')))).toBeUndefined()
})

test.skipIf(!HAS_CANVAS_BUILD)(
  'studio serves the built canvas and prints a usable URL',
  async () => {
    const directory = await tempDir('z1-studio-')
    const child = spawn(
      TSX,
      [
        BIN,
        'studio',
        '--port',
        '0',
        '--db',
        join(directory, 'runs.db'),
        '--graphs-dir',
        join(directory, 'graphs'),
        '--modules-dir',
        join(directory, 'modules'),
        '--no-open',
        '--json',
      ],
      { cwd: Z1_ROOT, stdio: 'pipe', env: { ...process.env } },
    )
    children.push(child)

    let stdout = ''
    let stderr = ''
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    const exited = new Promise<number>((resolve) => {
      child.on('close', (code) => {
        resolve(code ?? -1)
      })
    })
    const firstLine = new Promise<string>((resolve, reject) => {
      const onData = (chunk: Buffer): void => {
        stdout += chunk.toString('utf8')
        const newline = stdout.indexOf('\n')
        if (newline === -1) return
        child.stdout.off('data', onData)
        resolve(stdout.slice(0, newline))
      }
      child.stdout.on('data', onData)
      // A startup failure never prints a line, so surface stderr instead.
      void exited.then((code) => {
        child.stdout.off('data', onData)
        reject(new Error(`studio exited with ${String(code)} before printing: ${stderr}`))
      })
    })

    const info = JSON.parse(await firstLine) as StudioInfo
    expect(info.port).toBeGreaterThan(0)
    expect(info.ws).toBe(`ws://127.0.0.1:${String(info.port)}`)
    expect(info.url).toBe(
      `http://127.0.0.1:${String(info.port)}/?url=${info.ws}&token=${info.token}`,
    )

    const page = await fetch(info.url)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(await page.text()).toContain('<div id="root">')

    child.kill('SIGTERM')
    expect(await exited).toBe(0)
  },
  TIMEOUT_MS,
)
