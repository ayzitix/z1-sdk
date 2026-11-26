/**
 * Shared test scaffolding: a throwaway directory, an inner service that records
 * what reaches it, and a couple of casts that keep `Json` readable in a test.
 *
 * Nothing here reaches the network or a real `.env`: every spec builds its own
 * workspace under `tmpdir()` and removes it in `afterAll`.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdir } from 'node:fs/promises'

import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

/** A fresh directory that no other test and no real `.env` can be confused with. */
export async function temporaryDirectory(label: string): Promise<string> {
  return await mkdtemp(join(tmpdir(), `z1-env-keys-${label}-`))
}

/** Remove a directory a test made, ignoring the case where a test already did. */
export async function removeDirectory(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

/** Write a file, creating its parent directory: the workspace a scan walks. */
export async function writeWorkspaceFile(
  workspace: string,
  path: string,
  text: string,
): Promise<string> {
  const absolute = join(workspace, path)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, text, 'utf8')
  return absolute
}

/** A schema with the minimum the prompt builder reads. */
export function schema(name: string): ToolSchema {
  return { name, description: `${name} tool`, parameters: { type: 'object' } }
}

export interface InnerCall {
  name: string
  args: Json
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

/** Read a tool result as an object without a cast at every call site. */
export function asRecord(value: Json): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value
}

/** Read a tool result array without a cast at every call site. */
export function asArray(value: Json | undefined): readonly Json[] {
  if (!Array.isArray(value)) throw new Error('expected a JSON array')
  return value
}
