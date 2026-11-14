import { z } from 'zod'
import { defineNode, type Json, type NodeDefinition } from '@z1/node'
import {
  asJson,
  dataPort,
  errorMessage,
  flowPort,
  inputValues,
  isRecord,
  jsonValue,
  NODE_VERSION,
} from './shared.ts'

/**
 * Context hygiene, as two nodes rather than a policy inside the agent loop.
 *
 * `z1.ctx.budget` only observes: it turns a transcript into a token estimate and
 * a decision. Nothing is dropped, so putting it in a graph cannot change what
 * the model sees. `z1.ctx.clip` is the one node that rewrites content, and it
 * does so with a visible marker, so the model can tell the difference between a
 * short tool result and a clipped one.
 *
 * Both are deliberately model-agnostic: a window comes from config, and an
 * estimate is characters divided by a configurable ratio. The exact number lives
 * in the provider's `usage`, which is journaled on every turn.
 */

const DEFAULT_WINDOW = 128_000
const DEFAULT_RESERVE = 16_384
const DEFAULT_THRESHOLD = 0.85
const DEFAULT_CHARS_PER_TOKEN = 4

/**
 * Rough token estimate for a transcript.
 *
 * ASCII is divided by `charsPerToken` (4 is a common approximation). A
 * non-ASCII code unit counts as a full token: CJK and emoji tokenise at roughly
 * one token per character, so dividing them by four understates the window by
 * up to 4x, which is the direction that silently overflows.
 */
export function estimateText(text: string, charsPerToken: number): number {
  let ascii = 0
  let wide = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) < 0x80) ascii += 1
    else wide += 1
  }
  return Math.ceil(ascii / charsPerToken) + wide
}

export function estimateMessages(
  messages: readonly Json[],
  charsPerToken: number,
): number {
  let ascii = 0
  let wide = 0
  for (const message of messages) {
    const text = JSON.stringify(message) ?? ''
    for (let index = 0; index < text.length; index += 1) {
      if (text.charCodeAt(index) < 0x80) ascii += 1
      else wide += 1
    }
  }
  return Math.ceil(ascii / charsPerToken) + wide
}

function usageTokens(value: Json | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value)
  if (!isRecord(value)) return undefined
  const input = value['inputTokens']
  if (typeof input === 'number' && Number.isFinite(input) && input > 0) return Math.round(input)
  return undefined
}

const budget = defineNode({
  id: 'z1.ctx.budget',
  version: NODE_VERSION,
  title: 'Context budget',
  description:
    'Estimates the transcript size against a window and reports whether it is time to compact. Drops nothing.',
  category: 'context',
  config: z.object({
    contextWindow: z.number().int().positive().default(DEFAULT_WINDOW),
    reserveTokens: z.number().int().nonnegative().default(DEFAULT_RESERVE),
    /** Fraction of the usable window at which a caller should start compacting. */
    threshold: z.number().gt(0).max(1).default(DEFAULT_THRESHOLD),
    charsPerToken: z.number().positive().default(DEFAULT_CHARS_PER_TOKEN),
  }),
  defaultConfig: {},
  // Cheap and pure, but its output is the whole transcript: caching it would
  // key on a growing array (no hits) and keep another copy per iteration.
  cacheable: false,
  inputs: [
    dataPort('messages', z.array(jsonValue), false),
    /**
     * Tokens the provider reported for the last request. Authoritative when
     * present; the estimate is a floor, never an overstatement of it.
     */
    dataPort('usage', jsonValue, false),
  ],
  outputs: [
    dataPort('messages', z.array(jsonValue)),
    dataPort('tokens', z.number()),
    dataPort('window', z.number()),
    dataPort('triggerAt', z.number()),
    dataPort('ratio', z.number()),
    dataPort('over', z.boolean()),
  ],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    const raw = values['messages']
    // Silently treating a malformed transcript as empty would make the one
    // observe-only node change what the model sees.
    if (raw !== undefined && !Array.isArray(raw)) {
      throw new Error('z1.ctx.budget: the "messages" input must be an array')
    }
    const messages = raw ?? []
    const window = ctx.config.contextWindow
    const reserve = Math.min(ctx.config.reserveTokens, window)
    const usable = Math.max(1, window - reserve)
    // A reserve that covers the window must not produce a threshold of zero:
    // that would warn on an empty transcript on every iteration.
    const triggerAt = Math.max(1, Math.floor(usable * ctx.config.threshold))

    const estimated = estimateMessages(messages, ctx.config.charsPerToken)
    // A transcript can include tool schemas the estimate cannot see, so a
    // reported number wins when it is larger.
    const reported = usageTokens(values['usage'])
    const tokens = reported === undefined ? estimated : Math.max(estimated, reported)
    const ratio = tokens / window
    const over = tokens >= triggerAt

    if (over) {
      ctx.log(
        'warn',
        `context budget: ~${String(tokens)} of ${String(window)} tokens (${(ratio * 100).toFixed(0)}%), over the ${String(triggerAt)} compaction threshold`,
        { tokens, window, triggerAt },
      )
    } else {
      ctx.log('debug', `context budget: ~${String(tokens)} of ${String(window)} tokens`, {
        tokens,
        window,
      })
    }

    return {
      messages: asJson(messages),
      tokens,
      window,
      triggerAt,
      ratio,
      over,
    }
  },
})

/** Keep a spill path printable and filesystem-safe. */
function safeSegment(value: string, fallback: string): string {
  const cleaned = value.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  // `.` and `..` survive the character filter and would navigate the path.
  if (cleaned.length === 0 || cleaned === '.' || cleaned === '..') return fallback
  return cleaned.slice(0, 80)
}

/**
 * Sentinel in front of the marker.
 *
 * A tool result can contain the marker text itself; the invisible separator
 * makes an accidentally identical prefix unlikely without hiding the notice
 * from the model.
 */
const MARKER_SENTINEL = '\u2063'

/** Cut at a code-point boundary, so a surrogate pair is never split. */
function headEnd(text: string, index: number): number {
  if (index <= 0) return 0
  const code = text.charCodeAt(index - 1)
  // High surrogate at the end of the head: keep the pair for the tail.
  return code >= 0xd800 && code <= 0xdbff ? index - 1 : index
}

function tailStart(text: string, index: number): number {
  if (index >= text.length) return text.length
  const code = text.charCodeAt(index)
  // Low surrogate at the start of the tail: drop it, the head kept the pair.
  return code >= 0xdc00 && code <= 0xdfff ? index + 1 : index
}

const clip = defineNode({
  id: 'z1.ctx.clip',
  version: NODE_VERSION,
  title: 'Clip text',
  description:
    'Keeps the head and tail of a long tool result, writes the full text to the workspace and marks what was cut.',
  category: 'context',
  config: z.object({
    maxChars: z.number().int().positive().default(12_000),
    /** Share of `maxChars` kept from the start; the rest is the tail. */
    headRatio: z.number().gt(0).lt(1).default(0.5),
    spill: z.boolean().default(true),
    /**
     * Workspace-relative spill directory. An absolute path or a `..` segment is
     * rejected: the fs service would honour it, which would let a graph write
     * outside the workspace.
     */
    directory: z
      .string()
      .default('.z1/out')
      .refine(
        (value) =>
          value.length > 0 &&
          !value.startsWith('/') &&
          !/^[a-zA-Z]:/.test(value) &&
          !value.split(/[\\/]+/).includes('..'),
        { message: 'directory must be a relative path without ".."' },
      ),
  }),
  defaultConfig: {},
  // Writes the spill file, so it can never be reused from the run cache.
  cacheable: false,
  inputs: [flowPort('in'), dataPort('value', jsonValue), dataPort('name', z.string(), false)],
  outputs: [
    dataPort('value', jsonValue),
    dataPort('truncated', z.boolean()),
    dataPort('originalChars', z.number()),
    dataPort('spillPath', z.string()),
    flowPort('out'),
  ],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    const raw = values['value']
    // A tool may return an object; the message content is text, so serialize it
    // once here rather than letting the model see a clipped JSON fragment.
    const text = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null)
    const nameValue = values['name']
    const toolName = typeof nameValue === 'string' ? nameValue : undefined

    if (text.length <= ctx.config.maxChars) {
      return {
        value: asJson(raw ?? null),
        truncated: false,
        originalChars: text.length,
        spillPath: '',
        out: true,
      }
    }

    // Space for the marker itself, so the result really is at most `maxChars`.
    // A small cap needs a smaller reserve, or nothing but the marker would fit;
    // the second pass below trims any remaining overflow.
    const markerReserve = Math.min(140, Math.max(16, Math.floor(ctx.config.maxChars / 3)))
    const keepBudget = Math.max(2, ctx.config.maxChars - markerReserve)
    // Clipping a barely-too-long result would make it longer; leave it alone.
    if (text.length - ctx.config.maxChars <= markerReserve) {
      return {
        value: asJson(raw ?? null),
        truncated: false,
        originalChars: text.length,
        spillPath: '',
        out: true,
      }
    }

    let headChars = Math.max(1, Math.floor(keepBudget * ctx.config.headRatio))
    let tailChars = Math.max(1, keepBudget - headChars)
    let omitted = text.length - headChars - tailChars

    let spillPath = ''
    if (ctx.config.spill) {
      const relative = [
        ctx.config.directory.replace(/\/+$/, ''),
        safeSegment(ctx.runId, 'run'),
        `${safeSegment(ctx.path, 'step')}${toolName === undefined ? '' : `-${safeSegment(toolName, 'tool')}`}.txt`,
      ].join('/')
      try {
        await ctx.fs.write(relative, text)
        spillPath = relative
      } catch (error) {
        // A missing spill is a smaller problem than losing the tool result.
        ctx.log('warn', `clip: cannot write ${relative}: ${errorMessage(error)}`)
      }
    }

    const where = spillPath === '' ? '' : `; full output at ${spillPath}`
    const marker = `\n${MARKER_SENTINEL}… [z1: clipped ${String(text.length)} chars, ${String(omitted)} omitted${where}] …${MARKER_SENTINEL}\n`

    // The marker length depends on the numbers it prints, so trim the kept text
    // by the difference and rebuild once. Never let clipping inflate the value.
    const overflow = headChars + tailChars + marker.length - ctx.config.maxChars
    if (overflow > 0) {
      headChars = Math.max(1, headChars - Math.ceil(overflow / 2))
      tailChars = Math.max(1, tailChars - Math.floor(overflow / 2))
      omitted = text.length - headChars - tailChars
    }
    const headCut = headEnd(text, headChars)
    const tailCut = tailStart(text, text.length - tailChars)
    const finalMarker = `\n${MARKER_SENTINEL}… [z1: clipped ${String(text.length)} chars, ${String(text.length - headCut - (text.length - tailCut))} omitted${where}] …${MARKER_SENTINEL}\n`
    const clipped = text.slice(0, headCut) + finalMarker + text.slice(tailCut)

    return {
      value: clipped,
      truncated: true,
      originalChars: text.length,
      spillPath,
      out: true,
    }
  },
})

/** Tags around the summary, so a later update pass can find its predecessor. */
const SUMMARY_OPEN = '<compacted-summary>'
const SUMMARY_CLOSE = '</compacted-summary>'

/**
 * The summarization directive, appended as the final user message.
 *
 * Replaying the real conversation before it (rather than using a separate
 * summarizer prompt) keeps this call a prefix of what the model already saw, so
 * a provider's warm prefix cache is reused. The section list is deliberately
 * fixed: a summary that silently drops "Next Step" is worse than a long one.
 */
const COMPACTION_INSTRUCTION = [
  'You are now acting as a compaction engine for this coding assistant. Condense the conversation ABOVE into a structured checkpoint so another model can resume the work without losing essential context.',
  '',
  'Output EXACTLY this Markdown structure, every section, in order. Terse bullets, no prose. Write "(none)" for an empty section; never omit one.',
  '',
  '## Primary Request and Intent',
  "- [the original and evolving goals; quote the user's exact wording where it matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, conventions, patterns in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error string: cause and fix, plus any user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet done]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and rationale, constraints, preferences, open questions]',
  '',
  'Rules:',
  '- Keep exact file paths, commands, error strings, identifiers and numbers.',
  '- Capture user corrections faithfully.',
  '- Do not mention this request or that the context was compacted.',
  `- If the conversation already contains a ${SUMMARY_OPEN} block, it is a PRIOR checkpoint: keep still-true facts, drop stale ones, merge newer information into one consolidated summary.`,
  '- Output only the checkpoint text. Do not call a tool.',
].join('\n')

const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free context. Treat it as established background and build on it without restating it. Continue from the messages that follow.'

function messageText(message: Json): string {
  if (!isRecord(message)) return ''
  const content = message['content']
  if (typeof content === 'string') return content
  // A tool result can be an object (`clip` passes a short one through as-is);
  // treating it as empty would silently exempt the largest results.
  return content === undefined ? '' : (JSON.stringify(content) ?? '')
}

function isToolResult(message: Json): boolean {
  return isRecord(message) && message['role'] === 'tool'
}

/**
 * Cut index for the kept tail: never start it with an orphan `tool` message.
 *
 * A tool message whose assistant call was dropped is rejected by every provider,
 * so the cut moves forward until the tail begins with a message that can stand
 * alone.
 */
function safeCut(messages: readonly Json[], keep: number): number {
  let cut = Math.max(0, messages.length - keep)
  while (cut < messages.length && isToolResult(messages[cut] as Json)) cut += 1
  return cut
}

const compact = defineNode({
  id: 'z1.ctx.compact',
  version: NODE_VERSION,
  title: 'Compact tool results',
  description:
    'Replaces the content of old tool results with a note. No model call, nothing reordered, every tool call kept.',
  category: 'context',
  config: z.object({
    /** How many of the most recent tool results to keep verbatim. */
    keepToolResults: z.number().int().nonnegative().default(3),
    /** Results shorter than this are not worth a marker. */
    minChars: z.number().int().min(64).default(400),
  }),
  defaultConfig: {},
  cacheable: false,
  inputs: [flowPort('in'), dataPort('messages', z.array(jsonValue))],
  outputs: [
    dataPort('messages', z.array(jsonValue)),
    dataPort('compacted', z.boolean()),
    dataPort('cleared', z.number()),
    dataPort('tokensBefore', z.number()),
    dataPort('tokensAfter', z.number()),
    flowPort('out'),
  ],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    const raw = values['messages']
    if (!Array.isArray(raw)) {
      throw new Error('z1.ctx.compact: the "messages" input must be an array')
    }
    const messages = raw as readonly Json[]
    const toolIndexes: number[] = []
    let lastAssistant = -1
    messages.forEach((message, index) => {
      if (isToolResult(message)) toolIndexes.push(index)
      if (isRecord(message) && message['role'] === 'assistant') lastAssistant = index
    })
    // A result produced after the last assistant turn has not been sent to the
    // model yet. Clearing it first would hide a tool output the model never saw.
    const seen = toolIndexes.filter((index) => index < lastAssistant)
    const clearable = seen.slice(0, Math.max(0, seen.length - ctx.config.keepToolResults))

    let cleared = 0
    const next = messages.map((message, index) => {
      if (!clearable.includes(index)) return message
      const text = messageText(message)
      if (text.length < ctx.config.minChars) return message
      cleared += 1
      return {
        ...(message as Record<string, Json>),
        content: `\u2063[cleared: earlier tool result, ${String(text.length)} chars · re-run the tool if it is needed again]`,
      }
    })

    const tokensBefore = estimateMessages(messages, 4)
    // Nothing cleared: hand back the very same array, so a caller can branch on
    // identity as well as on the flag.
    const result = cleared === 0 ? messages : next
    const tokensAfter = estimateMessages(result, 4)
    return {
      messages: asJson(result),
      compacted: cleared > 0,
      cleared,
      tokensBefore,
      tokensAfter,
      out: true,
    }
  },
})

const summarize = defineNode({
  id: 'z1.ctx.summarize',
  version: NODE_VERSION,
  title: 'Summarize context',
  description:
    'Replaces an older span of the conversation with a structured checkpoint written by the model, keeping the most recent turns verbatim.',
  category: 'context',
  config: z.object({
    /** Same handle the chat node uses; required when the port is not wired. */
    model: z.unknown().optional(),
    /** Recent messages kept verbatim; a tool message is never orphaned. */
    keepRecentTurns: z.number().int().positive().default(6),
    /** Output cap for the checkpoint itself. */
    maxSummaryTokens: z.number().int().positive().default(2_000),
    /** A checkpoint that does not save at least this share is discarded. */
    minimumReduction: z.number().min(0).lt(1).default(0.1),
    /** How many checkpoints a transcript may already contain before we stop. */
    maxCompactions: z.number().int().positive().default(3),
    /** Do not pay for a summary of a span smaller than this. */
    minDroppedTokens: z.number().int().nonnegative().default(256),
  }),
  defaultConfig: {},
  cacheable: false,
  inputs: [
    flowPort('in'),
    dataPort('messages', z.array(jsonValue)),
    dataPort('tools', z.array(jsonValue), false),
    dataPort('model', jsonValue, false),
  ],
  outputs: [
    dataPort('messages', z.array(jsonValue)),
    dataPort('summary', z.string()),
    dataPort('compacted', z.boolean()),
    dataPort('droppedTurns', z.number()),
    dataPort('tokensBefore', z.number()),
    dataPort('tokensAfter', z.number()),
    dataPort('usage', jsonValue),
    flowPort('out'),
  ],
  execute: async (ctx) => {
    const values = inputValues(ctx.input)
    const raw = values['messages']
    if (!Array.isArray(raw)) {
      throw new Error('z1.ctx.summarize: the "messages" input must be an array')
    }
    const messages = raw as readonly Json[]
    const before = estimateMessages(messages, 4)
    const noop = {
      messages: asJson(messages),
      summary: '',
      compacted: false,
      droppedTurns: 0,
      tokensBefore: before,
      tokensAfter: before,
      usage: {},
      out: true,
    }

    const checkpoints = messages.filter(
      (message) => isRecord(message) && messageText(message).includes(SUMMARY_OPEN),
    ).length
    if (checkpoints >= ctx.config.maxCompactions) {
      // Without a cap a transcript that stays over budget re-summarises on every
      // iteration, paying for a call that cannot help.
      ctx.log(
        'warn',
        `z1.ctx.summarize: already ${String(checkpoints)} checkpoints; not compacting again`,
      )
      return noop
    }

    const cut = safeCut(messages, ctx.config.keepRecentTurns)
    // The first message is the system prompt; it is never summarised and never
    // dropped, because the checkpoint replaces the middle, not the rules.
    const head = isRecord(messages[0]) && messages[0]['role'] === 'system' ? messages[0] : undefined
    let from = head === undefined ? 0 : 1
    // A transcript that starts with an orphan tool result (custom graph) would
    // produce a summary request a provider rejects; skip such a message.
    while (from < cut && isToolResult(messages[from] as Json)) from += 1
    if (cut <= from) return noop

    const dropped = messages.slice(from, cut)
    const tail = messages.slice(cut)
    if (dropped.length === 0) return noop
    if (estimateMessages(dropped, 4) < ctx.config.minDroppedTokens) {
      ctx.log('debug', 'z1.ctx.summarize: the droppable span is too small to summarise')
      return noop
    }

    const handle = ctx.config.model ?? values['model']
    // Keep the whole handle: `params` carries stream/temperature and would be
    // lost by copying only provider and model.
    const model =
      isRecord(handle) && typeof handle['provider'] === 'string' && typeof handle['model'] === 'string'
        ? (handle as { provider: string; model: string })
        : undefined
    if (model === undefined) {
      ctx.log('warn', 'z1.ctx.summarize: no model handle; returning the transcript unchanged')
      return noop
    }

    const tools = values['tools']
    let reply
    try {
      reply = await ctx.llm.chat({
        model,
        messages: [
          // The real request is system + transcript + tools; replaying the same
          // head keeps this call a prefix of it (warm prompt cache) and keeps a
          // tool-leading span valid.
          ...(head === undefined ? [] : [head]),
          ...(dropped as never[]),
          { role: 'user', content: COMPACTION_INSTRUCTION },
        ] as never,
        ...(Array.isArray(tools) ? { tools: tools as never } : {}),
        maxTokens: ctx.config.maxSummaryTokens,
      })
    } catch (error) {
      const message = errorMessage(error)
      // A cassette miss means the recording is not valid for this transcript:
      // swallowing it would turn a broken replay into a silent full-price run.
      // An auth/4xx error is a configuration problem, not a transient one.
      if (/cassette miss|unauthori[sz]ed|forbidden|\b40[13]\b/i.test(message)) {
        throw error
      }
      // Any other failure must not fail the run: the caller still has the
      // tier-0 result, which is a valid transcript.
      ctx.log('warn', `z1.ctx.summarize: summary call failed: ${message}`)
      return noop
    }

    const text = typeof reply.message.content === 'string' ? reply.message.content.trim() : ''
    if (text.length === 0) {
      ctx.log('warn', 'z1.ctx.summarize: the model returned an empty checkpoint')
      return noop
    }

    const checkpoint: Json = {
      role: 'user',
      content: `${CHECKPOINT_PREAMBLE}\n\n${SUMMARY_OPEN}\n${text}\n${SUMMARY_CLOSE}`,
    }
    const next = [...(head === undefined ? [] : [head]), checkpoint, ...tail]
    const after = estimateMessages(next, 4)
    if (after > before * (1 - ctx.config.minimumReduction)) {
      ctx.log(
        'warn',
        `z1.ctx.summarize: checkpoint saves too little (${String(before)} → ${String(after)} tokens); keeping the transcript`,
      )
      return noop
    }

    return {
      messages: asJson(next),
      summary: text,
      compacted: true,
      droppedTurns: dropped.length,
      tokensBefore: before,
      tokensAfter: after,
      usage: asJson(reply.usage ?? {}),
      out: true,
    }
  },
})

export const contextNodes: readonly NodeDefinition[] = [budget, clip, compact, summarize]

export { budget as contextBudget, clip as contextClip, compact as contextCompact, summarize as contextSummarize }
