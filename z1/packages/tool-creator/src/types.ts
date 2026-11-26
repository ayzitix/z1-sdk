/**
 * The contract between the `tool.create` decorator and whatever actually
 * creates a tool.
 *
 * The creator itself lives in the sibling `z2q-tool-sdk` checkout (product name
 * `z2q by z1`), which is not published on npm. This package therefore depends
 * on the *shape* below and reaches the real implementation lazily through
 * `./port.ts`: a caller never imports the sdk, and a test never needs it on
 * disk. The shapes are deliberately narrower than z2q's own `ToolRequest` and
 * `ToolProposal` — a `Json` sample input instead of `{ input, note }`, a
 * `string[][]` history instead of `{ attempt, issues }[]` — so the tool
 * boundary carries plain JSON and nothing from the other package leaks into a
 * graph.
 *
 * @module @z1/tool-creator/types
 */

import type { Json } from '@z1/node'

/** One `tool.create` call, as a model sends it. */
export interface ToolCreationRequest {
  /**
   * `tool.<slug>`: the prefix, then lowercase letters, digits and dashes
   * (at most 64 characters). The service enforces it; the creator would also
   * normalise a plain phrase, but a name a person approves should be exact.
   */
  name: string
  /** One or two sentences: what the tool must do. */
  purpose: string
  /** Optional sample inputs the smoke test runs. */
  examples?: Json[]
}

/** One smoke-test sample's outcome. `code` is set when the run reported one. */
export interface ToolProposalRun {
  ok: boolean
  /** Deny rows the runtime audit recorded for this run. */
  denied: number
  code?: string
}

/**
 * The risk class an approval prompt shows; ordered by severity.
 *
 * `secrets` sits above `writes`: reading a declared environment variable is how
 * a tool gets a credential, and the class is what the model repeats to the user.
 */
export type ToolProposalRisk = 'read-only' | 'writes' | 'secrets' | 'runs-programs' | 'network'

/**
 * A reviewed, built and smoke-tested tool project awaiting a human decision.
 *
 * Everything here is already plain JSON, because it is what `tool.create`
 * returns: the model reads the capability lines, and the person who installs
 * the tool reads the same text in the approval prompt.
 */
export interface ToolProposalSummary {
  name: string
  version: string
  sha256: string
  projectDir: string
  attempts: number
  /** What each rejected attempt was told to fix, one array per attempt. */
  history: string[][]
  smoke: { ok: boolean; runs: ToolProposalRun[] }
  /** Human sentences for an approval prompt, and its risk class. */
  capabilities: { lines: string[]; risk: ToolProposalRisk }
  /** Always the next step, never performed here. */
  next: string
}

/**
 * The seam the service calls through.
 *
 * `propose` is the whole feature: it asks for a tool, gets one reviewed, built
 * and smoke-tested, and returns the summary. `install` exists for a host that
 * installs on a person's explicit instruction; the service never calls it, and
 * neither does `tool.create`.
 */
export interface ToolCreatorPort {
  propose(
    request: ToolCreationRequest,
    options: { workspace: string },
  ): Promise<ToolProposalSummary>
  install(
    proposalDir: string,
    options: { approvedBy?: string },
  ): Promise<{ path: string; name: string; version: string }>
}

/**
 * The host's model call, the same hook `createToolCreator` takes.
 *
 * `issues` is opaque to this package: on a retry z2q hands back the review
 * issues the previous reply had to fix, and the host forwards them to its
 * model unchanged.
 */
export type ToolGenerate = (request: {
  /** The tool-authoring rules, from z2q's `buildToolPrompt`. */
  system: string
  /** The request, with the repair note appended on a retry. */
  user: string
  /** 1-based attempt counter. */
  attempt: number
  /** Non-empty only on a retry. */
  issues?: readonly unknown[]
}) => Promise<string>

/**
 * The command a person runs to install a proposal; the tool never runs it.
 *
 * `z1 tool` is the z1 console's route to the same binary (`z1-tool` in the
 * SDK's own package), and it is the one that exists wherever the console does:
 * a proposal whose next step needed a separate install to have a command on
 * PATH was printed with a command the user could not run.
 */
export function toolInstallCommand(projectDir: string): string {
  return `z1 tool install ${projectDir}`
}

/**
 * The sentence every summary carries as `next`.
 *
 * The tool never installs: installation is a person's decision, made after
 * reading the capability lines, so the only next step is the command that
 * performs it.
 */
export function toolInstallNext(projectDir: string): string {
  return `run \`${toolInstallCommand(projectDir)}\` to install it`
}
