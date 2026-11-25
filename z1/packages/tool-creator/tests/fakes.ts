/**
 * Test doubles: no network, no model, no sdk.
 *
 * `fakeInner` is a `ToolService` that records what reaches it, and `fakePort`
 * is a `ToolCreatorPort` that records its calls and returns a canned proposal.
 * Both are shaped like the real thing, so a test that passes here passes
 * against z2q without the test knowing z2q exists.
 */

import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import type {
  ToolCreationRequest,
  ToolCreatorPort,
  ToolProposalSummary,
} from '../src/index.ts'

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

/** One `propose` call, exactly as the service made it. */
export interface PortProposalCall {
  request: ToolCreationRequest
  options: { workspace: string }
}

export interface PortInstallCall {
  proposalDir: string
  approvedBy?: string
}

/** A port that records its calls; `error` makes `propose` throw it instead. */
export interface FakePort extends ToolCreatorPort {
  readonly proposals: PortProposalCall[]
  readonly installs: PortInstallCall[]
}

/** A plausible proposal, in the shape a real port returns. */
export function proposal(overrides: Partial<ToolProposalSummary> = {}): ToolProposalSummary {
  return {
    name: 'tool.find-todos',
    version: '0.1.0',
    sha256: 'a'.repeat(64),
    projectDir: '/work/.z2q/proposals/tool.find-todos-1-1700000000000',
    attempts: 1,
    history: [],
    smoke: { ok: true, runs: [{ ok: true, denied: 0 }] },
    capabilities: { lines: ['Reads workspace files matching "**/*".'], risk: 'read-only' },
    next: 'ignored by the service, which states the next step itself',
    ...overrides,
  }
}

export function fakePort(
  options: { summary?: ToolProposalSummary; error?: unknown } = {},
): FakePort {
  const proposals: PortProposalCall[] = []
  const installs: PortInstallCall[] = []
  return {
    proposals,
    installs,
    async propose(request, call): Promise<ToolProposalSummary> {
      proposals.push({ request, options: call })
      if (options.error !== undefined) throw options.error
      return options.summary ?? proposal()
    },
    async install(proposalDir, call): Promise<{ path: string; name: string; version: string }> {
      installs.push({
        proposalDir,
        ...(call.approvedBy === undefined ? {} : { approvedBy: call.approvedBy }),
      })
      return { path: `/tools/${proposalDir}`, name: 'tool.find-todos', version: '0.1.0' }
    },
  }
}

/**
 * An error as it arrives from another module: an `Error` with the sdk's fields
 * grafted on, so no `instanceof` can recognise it.
 */
export function foreignError(code: string, message: string, issues?: Json[]): Error {
  return Object.assign(new Error(message), {
    name: 'ToolCreatorError',
    code,
    ...(issues === undefined ? {} : { issues }),
  })
}

/** Read a tool result as an object without a cast at every call site. */
export function asRecord(value: Json): Record<string, Json> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('expected a JSON object')
  }
  return value
}
