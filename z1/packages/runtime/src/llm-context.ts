/**
 * Which node is calling the model right now.
 *
 * `LlmService` is ambient: a transport never learns the execution path of its
 * caller, yet a recorded turn is useless without it. The executor therefore
 * opens an `AsyncLocalStorage` scope around `NodeDefinition.execute`, and the
 * recording decorator reads the scope at call time. Nothing else has to thread
 * a context argument through the node contract, and a nested graph or an
 * `await` inside a node keeps its own scope.
 *
 * @module @z1/runtime/llm-context
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface LlmCallContext {
  readonly runId: string
  readonly nodeId: string
  /** Hierarchical execution path of the node, e.g. `loop1/0/chat`. */
  readonly path: string
  readonly attempt: number
}

const storage = new AsyncLocalStorage<LlmCallContext>()

/** Run `fn` with `context` as the current model-call scope. */
export function withLlmCallContext<T>(context: LlmCallContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** The innermost scope, or `undefined` outside any node execution. */
export function currentLlmCallContext(): LlmCallContext | undefined {
  return storage.getStore()
}
