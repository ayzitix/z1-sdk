/**
 * Yields the payload of every `data:` line of an SSE body.
 *
 * Line framing is handled here rather than in the service so a single network
 * chunk may carry several events (or half of one) without losing data.
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
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = stripCarriageReturn(buffer.slice(0, newline))
        buffer = buffer.slice(newline + 1)
        const payload = dataPayload(line)
        if (payload !== undefined) yield payload
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    const payload = dataPayload(stripCarriageReturn(buffer))
    if (payload !== undefined) yield payload
  } finally {
    reader.releaseLock()
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function dataPayload(line: string): string | undefined {
  if (!line.startsWith('data:')) return undefined
  const rest = line.slice('data:'.length)
  return rest.startsWith(' ') ? rest.slice(1) : rest
}
