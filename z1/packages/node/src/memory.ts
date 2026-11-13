import type { ChatMessage } from './types.ts'

/**
 * Which part of the branch tree a node wants summarized. All fields are
 * optional so a node can ask for the default envelope with only a run id.
 */
export interface MemoryContextRequest {
  runId: string
  /** Execution path of the asking node; reserved for path-scoped recall. */
  path?: string
  /** Hard cap on the rendered text. Defaults to 4000 characters. */
  budgetChars?: number
  /** How many recent steps of the current run to include. Defaults to 8. */
  recentNodes?: number
}

/** One completed step of a run, as reported by a memory implementation. */
export interface MemoryRecentNode {
  path: string
  type: string
  summary: string
}

/**
 * The assembled external memory for one run: a rendered text block plus the
 * same content as chat messages, so a graph can either prompt or prepend.
 */
export interface MemoryEnvelope {
  text: string
  messages: ChatMessage[]
  /** Rendered ancestor lines, most distant first. */
  spine: string[]
  /** Rendered sibling-branch lines. */
  siblings: string[]
  recent: MemoryRecentNode[]
}

/**
 * Optional runtime service. A host that supplies none leaves every memory node
 * with an empty envelope, which keeps fresh graphs byte-for-byte unchanged.
 */
export interface MemoryService {
  buildContext(request: MemoryContextRequest): Promise<MemoryEnvelope>
  writeSummary?(input: {
    runId: string
    path?: string
    text: string
    sources?: string[]
  }): Promise<void>
}
