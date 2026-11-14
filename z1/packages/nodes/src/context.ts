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

export const contextNodes: readonly NodeDefinition[] = [budget, clip]

export { budget as contextBudget, clip as contextClip }
