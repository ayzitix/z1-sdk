import type { ToolSchema } from '@z1/node'
import {
  DEFAULT_SUBAGENT_MAX_DEPTH,
  MAX_SUBAGENT_DESCRIPTION_LENGTH,
  MAX_SUBAGENT_PROMPT_BYTES,
  MAX_SUBAGENT_TOOL_ENTRIES,
  MAX_SUBAGENT_TOOL_NAME_LENGTH,
  SUBAGENT_TOOL_NAME,
  SubagentError,
  SubagentGrantError,
  type SubagentGrantErrorCode,
  type SubagentInput,
  type SubagentInputLimits,
  type ToolGrant,
  type ToolGrantContext,
} from './types.ts'

const utf8 = new TextEncoder()

/**
 * Exact printable tool identifiers. z1 tool names are module-defined, so the
 * grammar is deliberately permissive: only whitespace, control characters, a
 * backtick (prompt formatting) and `*` (the whole-set pattern) are rejected.
 * Dots, slashes, colons, dashes, `@`, `+` and similar printable characters are
 * all valid exact names.
 */
const TOOL_NAME_FORBIDDEN = /[\s\u0000-\u001f\u007f-\u009f`]/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new SubagentError('invalid_input', `${label} has unknown property "${key}"`)
    }
  }
}

function positiveLimit(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new SubagentError(
      'invalid_input',
      `${name} must be an integer >= 1, got ${String(value)}`,
    )
  }
  return value
}

/**
 * Trim and validate one exact tool name. `"*"` is intentionally handled by the
 * caller so the two grant lists can give it different meanings.
 */
export function normalizeToolName(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new SubagentGrantError('invalid_name', `${field} entries must be strings`)
  }
  const name = value.trim()
  if (name.length === 0) {
    throw new SubagentGrantError('invalid_name', `${field} contains an empty tool name`)
  }
  if (name.length > MAX_SUBAGENT_TOOL_NAME_LENGTH) {
    throw new SubagentGrantError(
      'invalid_name',
      `${field} tool name is longer than ${String(MAX_SUBAGENT_TOOL_NAME_LENGTH)} characters`,
    )
  }
  if (name.includes('*')) {
    throw new SubagentGrantError(
      'invalid_name',
      `${field} contains an invalid tool name ${JSON.stringify(name)}; "*" is only valid as the sole entry in enable`,
    )
  }
  if (TOOL_NAME_FORBIDDEN.test(name)) {
    throw new SubagentGrantError(
      'invalid_name',
      `${field} contains an invalid tool name ${JSON.stringify(name)}`,
    )
  }
  return name
}

/**
 * Validate the model-facing shape and size limits. Tool-name semantics belong
 * to {@link resolveToolGrant}; this function also enforces the list-entry and
 * name-length caps so oversized input is rejected before grant resolution.
 */
export function parseSubagentInput(
  input: unknown,
  limits: SubagentInputLimits = {},
): SubagentInput {
  const maxDescription = positiveLimit(
    limits.maxDescriptionLength ?? MAX_SUBAGENT_DESCRIPTION_LENGTH,
    'maxDescriptionLength',
  )
  const maxPrompt = positiveLimit(
    limits.maxPromptBytes ?? MAX_SUBAGENT_PROMPT_BYTES,
    'maxPromptBytes',
  )
  const maxToolEntries = positiveLimit(
    limits.maxToolEntries ?? MAX_SUBAGENT_TOOL_ENTRIES,
    'maxToolEntries',
  )
  const maxToolNameLength = positiveLimit(
    limits.maxToolNameLength ?? MAX_SUBAGENT_TOOL_NAME_LENGTH,
    'maxToolNameLength',
  )

  if (!isRecord(input)) {
    throw new SubagentError('invalid_input', 'subagent input must be an object')
  }
  rejectUnknownKeys(input, ['description', 'prompt', 'tools'], 'subagent input')

  const description = input['description']
  if (typeof description !== 'string') {
    throw new SubagentError('invalid_input', 'subagent input.description must be a string')
  }
  if (description.trim().length === 0) {
    throw new SubagentError('invalid_input', 'subagent input.description must not be empty')
  }
  if (description.length > maxDescription) {
    throw new SubagentError(
      'invalid_input',
      `subagent input.description is longer than ${String(maxDescription)} characters`,
    )
  }

  const prompt = input['prompt']
  if (typeof prompt !== 'string') {
    throw new SubagentError('invalid_input', 'subagent input.prompt must be a string')
  }
  if (prompt.trim().length === 0) {
    throw new SubagentError('invalid_input', 'subagent input.prompt must not be empty')
  }
  const promptBytes = utf8.encode(prompt).byteLength
  if (promptBytes > maxPrompt) {
    throw new SubagentError(
      'invalid_input',
      `subagent input.prompt is ${String(promptBytes)} bytes; the limit is ${String(maxPrompt)}`,
    )
  }

  const tools = input['tools']
  if (!isRecord(tools)) {
    throw new SubagentError(
      'invalid_input',
      'subagent input.tools must be an object with an "enable" array',
    )
  }
  rejectUnknownKeys(tools, ['enable', 'disable'], 'subagent input.tools')

  const enable = tools['enable']
  if (!Array.isArray(enable)) {
    throw new SubagentError('invalid_input', 'subagent input.tools.enable must be an array')
  }
  if (enable.length > maxToolEntries) {
    throw new SubagentError(
      'invalid_input',
      `subagent input.tools.enable may contain at most ${String(maxToolEntries)} entries`,
    )
  }
  const enableNames: string[] = []
  for (const entry of enable) {
    if (typeof entry !== 'string') {
      throw new SubagentError(
        'invalid_input',
        'subagent input.tools.enable entries must be strings',
      )
    }
    if (entry.trim().length > maxToolNameLength) {
      throw new SubagentError(
        'invalid_input',
        `subagent input.tools.enable tool name is longer than ${String(maxToolNameLength)} characters`,
      )
    }
    enableNames.push(entry)
  }

  let disableNames: string[] | undefined
  const disable = tools['disable']
  if (disable !== undefined) {
    if (!Array.isArray(disable)) {
      throw new SubagentError(
        'invalid_input',
        'subagent input.tools.disable must be an array when present',
      )
    }
    if (disable.length > maxToolEntries) {
      throw new SubagentError(
        'invalid_input',
        `subagent input.tools.disable may contain at most ${String(maxToolEntries)} entries`,
      )
    }
    disableNames = []
    for (const entry of disable) {
      if (typeof entry !== 'string') {
        throw new SubagentError(
          'invalid_input',
          'subagent input.tools.disable entries must be strings',
        )
      }
      if (entry.trim().length > maxToolNameLength) {
        throw new SubagentError(
          'invalid_input',
          `subagent input.tools.disable tool name is longer than ${String(maxToolNameLength)} characters`,
        )
      }
      disableNames.push(entry)
    }
  }

  return {
    description,
    prompt,
    tools: {
      enable: enableNames,
      ...(disableNames === undefined ? {} : { disable: disableNames }),
    },
  }
}

function grantFailure(
  code: SubagentGrantErrorCode,
  message: string,
  requested: readonly string[] = [],
  denied: readonly string[] = [],
): never {
  throw new SubagentGrantError(code, message, { requested, denied })
}

function readList(
  selection: Record<string, unknown>,
  key: 'enable' | 'disable',
  maxEntries: number,
): readonly unknown[] {
  const value = selection[key]
  if (value === undefined) {
    if (key === 'enable') {
      grantFailure('invalid_tools', 'subagent tools.enable is required')
    }
    return []
  }
  if (!Array.isArray(value)) {
    grantFailure('invalid_tools', `subagent tools.${key} must be an array`)
  }
  if (value.length > maxEntries) {
    grantFailure(
      'too_many_tools',
      `subagent tools.${key} may contain at most ${String(maxEntries)} entries`,
    )
  }
  return value
}

function readInventory(
  inventory: ToolGrantContext['inventory'],
): {
  readonly installed: Map<string, ToolSchema>
  readonly ceiling: readonly string[]
  readonly ceilingSet: Set<string>
} {
  const installed = new Map<string, ToolSchema>()
  for (const schema of inventory.installed) {
    if (!isRecord(schema) || typeof schema.name !== 'string') {
      grantFailure('invalid_tools', 'parent tool inventory contains a tool without a name')
    }
    if (installed.has(schema.name)) {
      grantFailure(
        'duplicate_tool',
        `parent tool inventory contains duplicate tool "${schema.name}"`,
      )
    }
    installed.set(schema.name, schema)
  }

  const ceiling: string[] = []
  const ceilingSet = new Set<string>()
  for (const schema of inventory.enabled) {
    if (!isRecord(schema) || typeof schema.name !== 'string') {
      grantFailure('invalid_tools', 'parent effective tool set contains a tool without a name')
    }
    if (!installed.has(schema.name)) {
      grantFailure(
        'invalid_tools',
        `parent effective tool set names "${schema.name}", which is not installed`,
      )
    }
    if (ceilingSet.has(schema.name)) {
      grantFailure(
        'duplicate_tool',
        `parent effective tool set contains duplicate tool "${schema.name}"`,
      )
    }
    ceilingSet.add(schema.name)
    ceiling.push(schema.name)
  }

  return { installed, ceiling, ceilingSet }
}

/**
 * Turn a model-supplied selection into a grant that cannot exceed the parent's
 * effective tool set.
 *
 * Rules:
 * - `enable` is required; `[]` means no tools; `["*"]` means the parent's whole
 *   effective set (minus the delegation tool itself).
 * - Every explicit name must be installed *and* enabled for the parent.
 * - `disable` is applied afterwards; a name in both is denied and reported.
 * - A `disable` typo is an error, never a silent no-op.
 * - v1 has no nested delegation: the delegation tool is always rejected when
 *   named explicitly and skipped by `"*"`; `maxDepth` is clamped to 1.
 * - Names are returned in parent `list()` order, which is the deterministic
 *   order both the child graph and its prompt use.
 */
export function resolveToolGrant(
  selection: unknown,
  context: ToolGrantContext,
): ToolGrant {
  if (!isRecord(selection)) {
    grantFailure('invalid_tools', 'subagent tools must be an object')
  }
  for (const key of Object.keys(selection)) {
    if (key !== 'enable' && key !== 'disable') {
      grantFailure('invalid_tools', `subagent tools has unknown property "${key}"`)
    }
  }

  const maxEntries = positiveLimit(
    context.maxEntries ?? MAX_SUBAGENT_TOOL_ENTRIES,
    'maxEntries',
  )
  const depth = context.depth ?? 0
  if (!Number.isInteger(depth) || depth < 0) {
    grantFailure('invalid_tools', `grant depth must be a non-negative integer, got ${String(depth)}`)
  }
  const maxDepthInput = context.maxDepth ?? DEFAULT_SUBAGENT_MAX_DEPTH
  if (!Number.isInteger(maxDepthInput) || maxDepthInput < 0) {
    grantFailure(
      'invalid_tools',
      `grant maxDepth must be a non-negative integer, got ${String(maxDepthInput)}`,
    )
  }
  // v1 has exactly one delegation level. A larger configured value is clamped
  // rather than left as an exported capability that contradicts the contract.
  const maxDepth = Math.min(maxDepthInput, DEFAULT_SUBAGENT_MAX_DEPTH)
  const toolName = normalizeToolName(
    context.toolName ?? SUBAGENT_TOOL_NAME,
    'subagent tool name',
  )

  const rawEnable = readList(selection, 'enable', maxEntries)
  const rawDisable = readList(selection, 'disable', maxEntries)

  const normalizedEnable: string[] = []
  for (const entry of rawEnable) {
    if (typeof entry === 'string' && entry.trim() === '*') {
      normalizedEnable.push('*')
      continue
    }
    normalizedEnable.push(normalizeToolName(entry, 'subagent tools.enable'))
  }
  if (normalizedEnable.includes('*') && normalizedEnable.length !== 1) {
    grantFailure(
      'invalid_pattern',
      'subagent tools.enable: "*" must be the only entry in enable',
      normalizedEnable,
    )
  }

  const normalizedDisable = rawDisable.map((entry): string => {
    if (typeof entry === 'string' && entry.trim() === '*') {
      grantFailure('invalid_pattern', 'subagent tools.disable: "*" is not a valid tool name')
    }
    return normalizeToolName(entry, 'subagent tools.disable')
  })

  const enableNames = [...new Set(normalizedEnable)]
  const disableNames = [...new Set(normalizedDisable)]

  const { installed, ceiling, ceilingSet } = readInventory(context.inventory)
  const star = enableNames.length === 1 && enableNames[0] === '*'

  let requested: readonly string[]
  if (star) {
    requested = ceiling.filter((name) => name !== toolName)
  } else {
    for (const name of enableNames) {
      // v1 has no nested delegation: an explicit name is always an error,
      // regardless of depth or a legacy maxDepth value. `"*"` skips it instead.
      if (name === toolName) {
        grantFailure(
          'depth_exceeded',
          `cannot grant the delegation tool "${name}": the child would run at depth ${String(depth + 1)}, but nested subagents are disabled in v1 (maxDepth ${String(maxDepth)})`,
          enableNames,
        )
      }
      if (!installed.has(name)) {
        grantFailure('unknown_tool', `no installed tool named "${name}"`, enableNames)
      }
      if (!ceilingSet.has(name)) {
        grantFailure(
          'disabled_tool',
          `tool "${name}" is installed but not enabled for the parent`,
          enableNames,
        )
      }
    }
    const wanted = new Set(enableNames)
    requested = ceiling.filter((name) => wanted.has(name))
  }

  const disableSet = new Set<string>()
  for (const name of disableNames) {
    if (!installed.has(name)) {
      grantFailure(
        'unknown_tool',
        `no installed tool named "${name}" in disable`,
        requested,
      )
    }
    if (!ceilingSet.has(name)) {
      grantFailure(
        'disabled_tool',
        `tool "${name}" is installed but not enabled for the parent (disable)`,
        requested,
      )
    }
    disableSet.add(name)
  }

  const denied = requested.filter((name) => disableSet.has(name))
  const names = requested.filter((name) => !disableSet.has(name))
  return { requested, names, denied }
}
