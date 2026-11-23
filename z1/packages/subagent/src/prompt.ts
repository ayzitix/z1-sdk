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
    '## Fixed tool grant',
    tools,
    'The grant is fixed for the whole run. Tools that are not listed do not exist for you and cannot be enabled. Do not invent a result for a tool you do not have, and do not work around a missing tool by other means.',
    'If the task requires a tool that is not in this list, say so in your first sentence, name the missing tool, and explain what remains possible. Do not begin with exploration or a promise of the result.',
  ].join('\n')
}
