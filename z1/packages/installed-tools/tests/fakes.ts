/**
 * Test doubles and an install fixture: no network, no model, no checkout.
 *
 * `fakeInner` is a `ToolService` that records what reaches it. `installFixture`
 * writes what `installTool` writes — `approval.json`, `dist/tool.json` and a
 * bundle — so a test can pin the inventory and the routing without building
 * anything through z2q, and can break one file on purpose.
 */

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import type { InstalledToolLogLevel } from '../src/index.ts'

/**
 * The sibling checkout, when this machine has it.
 *
 * The suite must pass without it: z2q is not published on npm, and a person who
 * only has this repository cannot be expected to own a second one.
 */
export const SIBLING_SDK =
  process.env['Z1_TOOL_SDK_PATH'] ?? 'C:/Users/oleksii/Documents/z1-projects/z1-tool-sdk'

/** Both entries `@z1/installed-tools` imports from a built checkout. */
export const HAS_SIBLING =
  existsSync(join(SIBLING_SDK, 'dist', 'index.js')) &&
  existsSync(join(SIBLING_SDK, 'dist', 'runtime', 'index.js'))

/** A schema with the minimum the prompt builder reads. */
export function schema(name: string): ToolSchema {
  return { name, description: `${name} tool`, parameters: { type: 'object' } }
}

export interface LogLine {
  readonly level: InstalledToolLogLevel
  readonly message: string
  readonly data?: Json
}

export interface Recorder {
  readonly lines: LogLine[]
  readonly log: (level: InstalledToolLogLevel, message: string, data?: Json) => void
}

/** A log sink that keeps every line, in order. */
export function recorder(): Recorder {
  const lines: LogLine[] = []
  return {
    lines,
    log: (level, message, data) => {
      lines.push(data === undefined ? { level, message } : { level, message, data })
    },
  }
}

export interface InnerCall {
  readonly name: string
  readonly args: Json
}

/** An inner service that records every call and answers in a fixed shape. */
export interface FakeInner extends ToolService {
  readonly calls: InnerCall[]
}

export function fakeInner(
  names: readonly string[],
  options: { result?: (name: string, args: Json) => Json; error?: Error } = {},
): FakeInner {
  const calls: InnerCall[] = []
  return {
    calls,
    async list(): Promise<readonly ToolSchema[]> {
      return names.map(schema)
    },
    async call(name: string, args: Json): Promise<Json> {
      calls.push({ name, args })
      if (options.error !== undefined) throw options.error
      return options.result === undefined ? { tool: name, args } : options.result(name, args)
    },
  }
}

/** The resolved capabilities `installTool` records for the fixture. */
function fixtureCapabilities(): Record<string, Json> {
  return {
    fs: { read: ['**/*'], write: [] },
    process: { argv: [] },
    net: { hosts: [] },
    env: { read: [] },
    limits: { timeoutMs: 5000, maxOutputBytes: 65536 },
  }
}

export interface FixtureOptions {
  /** The tools root; `installTool` would have written `<workspace>/.z2q/tools`. */
  readonly toolsDir: string
  readonly name?: string
  readonly version?: string
  readonly description?: string
  readonly parameters?: Record<string, Json>
  /** The bundle text; changed on purpose by the tampering test. */
  readonly bundle?: string
}

export interface Fixture {
  readonly name: string
  readonly version: string
  readonly dir: string
  readonly manifest: Record<string, Json>
  readonly bundle: string
}

/** What the fixture writes by default: an ES module that only has to exist. */
const FIXTURE_BUNDLE = 'export const tool = { manifest: {} }\n'

/**
 * Write one installed tool exactly as `installTool` lays it out.
 *
 * The sha in `approval.json` is the hash of the bytes written here, so the
 * fixture passes z2q's own verification and only the file the test edits makes
 * it fail — which is what makes a tamper test mean something.
 */
export async function installFixture(options: FixtureOptions): Promise<Fixture> {
  const name = options.name ?? 'tool.fixture'
  const version = options.version ?? '1.0.0'
  const description =
    options.description ?? 'Fixture tool written by the installed-tools test suite.'
  const parameters = options.parameters ?? { type: 'object', properties: {} }
  const bundle = options.bundle ?? FIXTURE_BUNDLE
  const capabilities = fixtureCapabilities()
  const manifest: Record<string, Json> = {
    schemaVersion: 1,
    name,
    version,
    description,
    parameters,
    capabilities,
  }

  const dir = join(options.toolsDir, name, version)
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'dist', 'tool.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  await writeFile(join(dir, 'dist', 'index.js'), bundle, 'utf8')
  await writeFile(
    join(dir, 'approval.json'),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        name,
        version,
        sha256: createHash('sha256').update(bundle).digest('hex'),
        capabilities,
        installedAt: '2026-01-02T03:04:05.000Z',
        approvedBy: 'test',
      },
      null,
      2,
    )}\n`,
    'utf8',
  )

  return { name, version, dir, manifest, bundle }
}

/** Read a tool result as an object without a cast at every call site. */
export function asRecord(value: Json): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value
}
