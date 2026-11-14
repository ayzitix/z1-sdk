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

function messageChars(message: Json): number {
  if (!isRecord(message)) return JSON.stringify(message).length
  let chars = 0
  const content = message['content']
  if (typeof content === 'string') chars += content.length
  else if (content !== undefined) chars += JSON.stringify(content).length
  const toolCalls = message['toolCalls']
  if (toolCalls !== undefined) chars += JSON.stringify(toolCalls).length
  return chars
}

/** Rough token estimate for a transcript; deliberately cheap and monotonic. */
export function estimateMessages(
  messages: readonly Json[],
  charsPerToken: number,
): number {
  let chars = 0
  for (const message of messages) chars += messageChars(message)
  return Math.ceil(chars / charsPerToken)
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
  // Pure arithmetic over its inputs; no side effect and nothing time-dependent.
  cacheable: true,
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
    const messages = Array.isArray(raw) ? raw : []
    const window = ctx.config.contextWindow
    const reserve = Math.min(ctx.config.reserveTokens, window)
    const usable = Math.max(1, window - reserve)
    const triggerAt = Math.floor(usable * ctx.config.threshold)

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
  return cleaned.length === 0 ? fallback : cleaned.slice(0, 80)
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
    directory: z.string().default('.z1/out'),
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

    const headChars = Math.max(1, Math.floor(ctx.config.maxChars * ctx.config.headRatio))
    const tailChars = Math.max(0, ctx.config.maxChars - headChars)
    const omitted = text.length - headChars - tailChars

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
    const marker = `\n… [z1: clipped ${String(text.length)} chars, ${String(omitted)} omitted${where}] …\n`
    const clipped =
      tailChars === 0
        ? text.slice(0, headChars) + marker
        : text.slice(0, headChars) + marker + text.slice(-tailChars)

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
