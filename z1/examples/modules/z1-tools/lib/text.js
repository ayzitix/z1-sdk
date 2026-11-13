/**
 * Text helpers: line splitting, `1| ` numbering and read windows.
 *
 * Line endings are normalised for display only; tools never rewrite a file
 * unless the caller asked them to.
 *
 * @module z1-tools/text
 */

/** Largest file `read` will load through the broker. */
export const MAX_READ_BYTES = 1024 * 1024
/** Lines returned by `read` when the caller does not ask for a window. */
export const MAX_READ_LINES = 2000
/** How much of a file is inspected for a NUL byte before reading it. */
export const BINARY_SNIFF_BYTES = 8 * 1024

export function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Split text into lines without their terminators.
 *
 * `"a\nb\n"` is two lines, `"a\n\n"` is two (one empty), and `""` is none.
 * Only `\n` (optionally preceded by `\r`) ends a line.
 */
export function splitLines(text) {
  const matches = text.match(/[^\n]*\n|[^\n]+/g) ?? []
  return matches.map((line) => {
    let value = line.endsWith('\n') ? line.slice(0, -1) : line
    if (value.endsWith('\r')) value = value.slice(0, -1)
    return value
  })
}

/**
 * Number a window of lines for a model: `1| first`, `2| second`.
 *
 * `offset` is 1-based; the window is clamped to the file. `truncated` is true
 * when lines exist after the window.
 */
export function readWindow(text, offset, limit) {
  const lines = splitLines(text)
  const start = offset - 1
  const selected = lines.slice(start, start + limit)
  const body = selected
    .map((line, index) => `${start + index + 1}| ${line}`)
    .join('\n')
  const end = start + selected.length
  return {
    body,
    total: lines.length,
    first: selected.length === 0 ? 0 : start + 1,
    last: end,
    truncated: end < lines.length,
  }
}

/**
 * The line ending a file already uses: CRLF when it contains one, else LF.
 *
 * Mixed files pick CRLF; the tools only use this to match and to normalise
 * replacement text, never to rewrite untouched lines.
 */
export function detectEol(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** Rewrite every line ending in `text` to `eol`. */
export function toEol(text, eol) {
  return text.replace(/\r\n/g, '\n').split('\n').join(eol)
}

/** A short single-line excerpt of a multi-line snippet, for error messages. */export function excerpt(text, maximum = 60) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maximum ? flat : `${flat.slice(0, maximum - 1)}…`
}

export function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}
