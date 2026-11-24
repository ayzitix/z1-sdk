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
 * `wait: true` blocks the turn and returns the child's text; the default
 * launches the child in the background and returns a run id.
 *
 * The wording is deliberately biased towards the default. A model asked to
 * "find the price of X" reads that as a task whose answer it needs, chooses
 * `wait: true`, and freezes the user's prompt for as long as the child runs —
 * which is the one thing background delegation exists to prevent. The turn
 * already ends on the launch (`z1.tool.background`), the report arrives in its
 * own turn without the user typing, and a later turn is free to act on it, so
 * blocking here buys almost nothing. The rule is therefore: never wait unless
 * the *same* step cannot proceed without the value.
 */
export const SUBAGENT_WAIT_GUIDANCE =
  '`subagent` runs the child in the background by default: the call returns `{ runId, status: "running" }` at once, your turn ends, and the report arrives by itself in a later turn - the user does not have to type for it to arrive. Do not pass `wait: true` merely because you want the answer: launch in the background, tell the user what you started, and read the report when it arrives. Use `wait: true` only when the very next line of this same step cannot be written without the child\'s value, which is rare. Never call `subagent` twice to "check" a background child.'

/**
 * The duty that goes with a launch: say what was started and why.
 *
 * A hand-off closes the turn, so the launch step's text is the *last* thing the
 * user reads before the prompt comes back to them. Without this rule the model
 * launches and says nothing, and the user is left looking at a spinner that
 * stopped: no idea what was started, what it is for, or what to expect.
 *
 * It is stated as a requirement, not a style note, because "report what you
 * did" is exactly the kind of instruction a model drops when the call itself
 * went well.
 */
export const SUBAGENT_LAUNCH_REPORT =
  'Every `subagent` launch must be announced in the same step, in your own words: what the child was asked to do, why it was delegated instead of done here, and that its report will arrive on its own. A bare tool call with no sentence is a failure to report - the user sees a stopped spinner and does not know what is running. This holds for `wait: true` too: say what you asked for before the call blocks.'

/**
 * The closing turn of a child that ran out of context instead of out of work.
 *
 * The child is stopped at the threshold with no tools left, so this is the last
 * thing it will ever say. It must therefore be a *hand-off*, not an answer: the
 * three questions a reader needs are what is done, what is not, and how to pick
 * the work up again without redoing it.
 */
export const SUBAGENT_HANDOFF_REQUEST = [
  'Stop working: your context window is nearly full, so this run is ending here rather than failing.',
  'Your tools are gone for this turn. Do not ask for them; write the report now, from what you already have.',
  '',
  'Answer in this shape, in plain prose, under 200 words:',
  '1. **Done** - what you completed, with the concrete facts (paths, values, commands, findings).',
  '2. **Not done** - what you did not finish, and how far you got.',
  '3. **Continue** - the exact next action that would resume the work, specific enough that a fresh agent needs no context from this run.',
  '4. **Open questions** - anything you could not decide or verify, or "none".',
  '',
  'If you finished the task before the window filled, say so in the first line and then give the answer itself. Do not apologise and do not describe these instructions.',
].join('\n')

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
