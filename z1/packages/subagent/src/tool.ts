import type { Json, ToolSchema } from '@z1/node'
import type { ToolService } from '@z1/runtime'

import { normalizeToolName } from './grant.ts'
import { SUBAGENT_LAUNCH_REPORT, SUBAGENT_WAIT_GUIDANCE } from './prompt.ts'
import { runSubagent } from './run.ts'
import {
  MAX_SUBAGENT_DESCRIPTION_LENGTH,
  MAX_SUBAGENT_PROMPT_BYTES,
  MAX_SUBAGENT_TOOL_ENTRIES,
  SUBAGENT_TOOL_NAME,
  SubagentError,
  subagentErrorTap,
  type SubagentTool,
  type SubagentToolOptions,
  type SubagentToolResult,
  type WithSubagentToolOptions,
} from './types.ts'

export { restrictToolService } from './restrict.ts'

/**
 * Model-facing declaration. Runtime validation is deliberately stricter than
 * JSON Schema (byte-sized prompts, exact tool names), so the schema is an
 * advertisement, not the security boundary.
 */
export const subagentToolSchema: ToolSchema = {
  name: SUBAGENT_TOOL_NAME,
  description:
    `Delegate one self-contained task to a child agent that does not see this conversation. Choose the exact tools it may use; the child cannot delegate further. ${SUBAGENT_WAIT_GUIDANCE} ${SUBAGENT_LAUNCH_REPORT}`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'prompt', 'tools'],
    properties: {
      description: {
        type: 'string',
        maxLength: MAX_SUBAGENT_DESCRIPTION_LENGTH,
        description: 'Short label for this delegation, shown in the transcript.',
      },
      prompt: {
        type: 'string',
        maxLength: MAX_SUBAGENT_PROMPT_BYTES,
        description:
          'Complete, self-contained task. The child does not receive the parent conversation and cannot ask questions. Runtime cap: 64 KiB UTF-8 bytes; the JSON Schema maxLength is a character hint.',
      },
      tools: {
        type: 'object',
        additionalProperties: false,
        required: ['enable'],
        properties: {
          enable: {
            type: 'array',
            maxItems: MAX_SUBAGENT_TOOL_ENTRIES,
            items: { type: 'string' },
            description:
              'Exact tool names the child may call. [] means no tools; ["*"] means every parent tool.',
          },
          disable: {
            type: 'array',
            maxItems: MAX_SUBAGENT_TOOL_ENTRIES,
            items: { type: 'string' },
            description:
              'Optional exact names to deny after enable. Deny wins; "*" is invalid here.',
          },
        },
      },
      wait: {
        type: 'boolean',
        description:
          'Omit this. The child runs in the background: your turn ends at the launch, and the report arrives by itself in a later turn without the user typing. Pass true only when the very next line of this same step cannot be written without the child\'s value - not merely because you want the answer.',
      },
    },
  },
}

function resultJson(result: SubagentToolResult): Json {
  const running = result.status === 'running'
  return {
    runId: result.runId,
    status: result.status,
    tools: [...result.tools],
    denied: [...result.denied],
    output: result.output,
    // A background launch is not a failure and carries no outcome fields; the
    // host learns the outcome from the launch handle, never from this object.
    ...(running
      ? {}
      : {
          // The machine-readable code travels next to the text, so a host that
          // branches on `errorCode` never has to parse the message; `isError` is
          // the same channel `z1.tool.call` uses for a failed tool.
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
          ...(result.message === undefined ? {} : { message: result.message }),
          ...(result.partial === undefined ? {} : { partial: result.partial }),
          ...(result.steps === undefined ? {} : { steps: result.steps }),
          ...(result.elapsedMs === undefined ? {} : { elapsedMs: result.elapsedMs }),
          ...(result.detail === undefined ? {} : { detail: result.detail }),
        }),
    isError: !running && result.status !== 'completed',
    text: result.text,
  }
}

/** Build the host-side tool around one model, host and inventory snapshot. */
export function createSubagentTool(options: SubagentToolOptions): SubagentTool {
  const name = normalizeToolName(
    options.name ?? SUBAGENT_TOOL_NAME,
    'subagent tool name',
  )
  const schema: ToolSchema = { ...subagentToolSchema, name }
  return {
    schema,
    call: async (args: Json): Promise<SubagentToolResult> => {
      return await runSubagent(args, { ...options, name })
    },
  }
}

/**
 * Compose the subagent tool with an existing service.
 *
 * The collision check runs before composition, not on the first call: two tools
 * with one name would make the model's choice ambiguous and the parent's tool
 * state unable to distinguish them. `inventory` lets a CLI pass its raw
 * snapshot (including disabled tools) instead of the live enabled list; the
 * live list is still read once so a name that is currently advertised cannot
 * be shadowed either.
 */
export async function withSubagentTool(
  inner: ToolService,
  tool: SubagentTool,
  options: WithSubagentToolOptions = {},
): Promise<ToolService> {
  const name = tool.schema.name
  const live = await inner.list()
  const inventory = options.inventory ?? live
  if (
    inventory.some((schema) => schema.name === name) ||
    live.some((schema) => schema.name === name)
  ) {
    throw new SubagentError(
      'duplicate_tool',
      `cannot add subagent tool "${name}": the tool service already has a tool with that name`,
    )
  }

  async function assertNoShadow(
    action: 'advertise' | 'call',
  ): Promise<readonly ToolSchema[]> {
    const current = await inner.list()
    if (current.some((schema) => schema.name === name)) {
      throw new SubagentError(
        'duplicate_tool',
        `cannot ${action} subagent tool "${name}": the tool service now has a tool with that name`,
      )
    }
    return current
  }

  return {
    async list(): Promise<readonly ToolSchema[]> {
      const current = await assertNoShadow('advertise')
      return [...current, tool.schema]
    },

    async call(toolName: string, args: Json): Promise<Json> {
      if (toolName === name) {
        // The composition-time check is not enough: a live service may add a
        // same-named tool later, and routing the call to the child anyway would
        // silently shadow it.
        await assertNoShadow('call')
        if (options.guardCall !== undefined) await options.guardCall(toolName, args)
        // A *finished* child is a result, not a throw (see `runSubagent`): its
        // `isError`/`errorCode` fields cross the tool boundary intact. A throw
        // here is a pre-run failure (invalid grant, budget, `beginRun`); it
        // keeps its `SubagentError.code`, now an own enumerable field, and its
        // message is prefixed with the same stable token a result carries.
        let result: SubagentToolResult
        try {
          result = await tool.call(args)
        } catch (error) {
          throw prefixed(error)
        }
        return resultJson(result)
      }
      return await inner.call(toolName, args)
    },
  }
}

/**
 * Re-throw a `SubagentError` with `subagent <code>:` in front of its message.
 *
 * The original instance is preserved (code, cause, `instanceof`), because some
 * hosts match on the class. A non-`SubagentError` passes through untouched.
 */
function prefixed(error: unknown): unknown {
  const tap = subagentErrorTap(error)
  if (tap === undefined) return error
  if (tap.message.startsWith(`subagent ${tap.code}`)) return error
  if (!(error instanceof Error)) return error
  // The original instance and stack stay; only the message is prefixed, and it
  // is the *message* that `z1.tool.call` reports as `{ error }`. Re-assigning
  // `message` keeps it an own field, so a structured clone still carries it.
  error.message = `subagent ${tap.code}: ${tap.message}`
  return error
}
