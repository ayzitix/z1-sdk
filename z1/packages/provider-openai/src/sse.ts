/**
 * Yields the payload of every `data:` line of an SSE body.
 *
 * Framing is handled here rather than in the service so a single network chunk
 * may carry several events (or half of one) without losing data. A line ends
 * with CRLF, LF or a bare CR, all of which the event-stream grammar allows, and
 * a body that stops mid-line is an error: the cut half of an event is not the
 * same as an event the provider never sent.
 */
export async function* readSseData(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder()
  const reader = body.getReader()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { lines, rest } = takeLines(buffer, false)
      buffer = rest
      for (const line of lines) {
        const payload = dataPayload(line)
        if (payload !== undefined) yield payload
      }
    }
    buffer += decoder.decode()
    const { lines, rest } = takeLines(buffer, true)
    for (const line of lines) {
      const payload = dataPayload(line)
      if (payload !== undefined) yield payload
    }
    if (rest.length > 0) {
      // A final line with no terminator is either the closing frame of a server
      // that omits it or the beginning of an event that never arrived. Only a
      // whole frame is safe to hand on.
      const payload = dataPayload(rest)
      if (payload === undefined || !isWholePayload(payload)) {
        throw new Error('openai-compatible stream ended mid-event')
      }
      yield payload
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Splits complete lines off `buffer`, holding a trailing CR back until the next
 * read because it may be the first half of a CRLF pair.
 */
function takeLines(buffer: string, final: boolean): { lines: string[]; rest: string } {
  const lines: string[] = []
  let start = 0
  let index = 0
  while (index < buffer.length) {
    const char = buffer[index]
    if (char !== '\n' && char !== '\r') {
      index += 1
      continue
    }
    if (char === '\r') {
      if (index + 1 === buffer.length && !final) break
      lines.push(buffer.slice(start, index))
      index += buffer[index + 1] === '\n' ? 2 : 1
      start = index
      continue
    }
    lines.push(buffer.slice(start, index))
    index += 1
    start = index
  }
  return { lines, rest: buffer.slice(start) }
}

/** A tail without a terminator counts only if it is a whole frame. */
function isWholePayload(payload: string): boolean {
  // The terminator may carry padding (`data: [DONE] `), as the service allows.
  if (payload.trimEnd() === '[DONE]') return true
  try {
    JSON.parse(payload)
    return true
  } catch {
    return false
  }
}

function dataPayload(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined
  const rest = line.slice('data:'.length)
  return rest.startsWith(' ') ? rest.slice(1) : rest
}
