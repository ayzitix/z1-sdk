/**
 * The model hook `tool.create` asks its host for.
 *
 * z2q's creator is deliberately model-agnostic: it builds the prompt pair and
 * the repair note, and the host makes the call. Here that call goes through the
 * **same composed `LlmService` the run uses**, so a tool proposal is recorded,
 * retried and billed like any other model turn of the run rather than through a
 * second, unmonitored path.
 *
 * The request carries exactly two messages — the system rules and the user
 * request — because `buildToolPrompt` returns a prompt pair, not a transcript.
 * On a retry the creator appends the previous review issues to `user` itself
 * (`repairUser`), so this hook never re-states them; `issues` is ignored on
 * purpose rather than duplicated.
 *
 * @module @z1/bootstrap/tool-creator
 */

import type { ChatMessage, ModelHandle } from '@z1/node'
import type { LlmService } from '@z1/runtime'
import type { ToolGenerate } from '@z1/tool-creator'

/** One tool-authoring turn, on the run's own model. */
export function toolCreatorGenerate(llm: LlmService, model: ModelHandle): ToolGenerate {
  return async ({ system, user }) => {
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ]
    const reply = await llm.chat({
      model,
      messages,
      // The creator reads a source file from the reply *text*. Offering tools
      // would only invite the model to call one instead of writing the file.
      tools: [],
    })
    const text = typeof reply.message.content === 'string' ? reply.message.content : ''
    if (text.trim().length === 0) {
      throw new Error('the tool creator model reply was empty')
    }
    return text
  }
}
