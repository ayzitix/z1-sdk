export interface SubagentPromptOptions {
  /** Exact granted tool names, in the order the child will see them. */
  readonly tools: readonly string[]
}

function label(name: string): string {
  // Names are validated before they reach a grant, but escaping here keeps the
  // prompt well-formed even if a caller uses this function on its own.
  return `\`${name.replaceAll('`', '\\`').replaceAll('\n', '\\n')}\``
}

/**
 * The one rule about `wait`, stated for the model in both places it reads: the
 * `subagent` tool description and a subagent's own system prompt (a child of
 * depth 0 could not delegate in v1, but the rule is about the tool it does not
 * have yet and must not be guessed at differently).
 *
 * `wait: true` blocks and returns the child's text; the default launches the
 * child in the background and returns a run id. The choice is made once, by
 * the caller, and it is a mistake to call the tool a second time to "check" a
 * background child: its output arrives on its own.
 */
export const SUBAGENT_WAIT_GUIDANCE =
  '`subagent` runs the child in the background by default: the call returns `{ runId, status: "running" }` at once and the child\'s output arrives at the start of a later turn. Pass `wait: true` only when you need the answer to continue this step; use the default for independent work you can start now and read later.'

/**
 * The custom system section for a child agent.
 *
 * It states the exact grant, that the grant is closed, and what a blocked child
 * must do: name the missing tool in its first sentence instead of working
 * around it. It never mentions the CLI-only `/tools` command or the parent's
 * other tools, because the child cannot act on either.
 */
export function subagentSystemPrompt(options: SubagentPromptOptions): string {
  const tools =
    options.tools.length === 0
      ? 'You have no tools for this run: you cannot read or write files, run commands, search, browse, or call any tool.'
      : `Your tools for this run are exactly: ${options.tools.map(label).join(', ')}.`

  return [
    'You are a subagent. The parent agent delegated one self-contained task to you.',
    'Your final message is the only thing the parent sees. You cannot ask questions or wait for input during this run, and you cannot delegate to another agent.',
    '',
    SUBAGENT_WAIT_GUIDANCE,
    '',
    '## Fixed tool grant',
    tools,
    'The grant is fixed for the whole run. Tools that are not listed do not exist for you and cannot be enabled. Do not invent a result for a tool you do not have, and do not work around a missing tool by other means.',
    'If the task requires a tool that is not in this list, say so in your first sentence, name the missing tool, and explain what remains possible. Do not begin with exploration or a promise of the result.',
  ].join('\n')
}
