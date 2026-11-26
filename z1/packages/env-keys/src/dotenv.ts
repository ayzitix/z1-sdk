/**
 * The `.env` file itself: parsed, rewritten and searched with no dependency.
 *
 * The file is not a data structure to this package, it is a document a person
 * also edits by hand, so every rewrite here is surgical: an assignment is
 * replaced from its `=` to the end of its own line, and every other byte —
 * comments, blank lines, indentation, a stray `export`, the CRLF a Windows
 * editor left behind — is carried through untouched. A line this module cannot
 * parse as an assignment is never rewritten, only skipped.
 *
 * The pure half ({@link readKeys}, {@link readSecrets}, {@link findLeaks},
 * {@link upsertAssignment}, {@link removeAssignment}) takes and returns text,
 * so the byte-identical promises are unit-testable without a filesystem. The
 * fs-backed half does the reading, the atomic write, the git questions and the
 * workspace walk.
 *
 * Two rules are the whole value model, and dotenv's own conventions:
 *
 * - a value wrapped in matching quotes ends at the closing quote, and the
 *   quotes are not part of it;
 * - an unquoted value ends at the first ` #`, which starts a comment.
 *
 * Values are only ever *counted* or *searched for*, never returned: no function
 * here hands a value to a caller, and every result that renders a file names a
 * path, a line and a key name.
 *
 * @module @z1/env-keys/dotenv
 */

import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmod, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { matchPath } from '@z1/module'

import { EnvKeysError } from './errors.ts'

/** Shortest value `scan` looks for. A shorter one matches half the workspace. */
export const MIN_SECRET_LENGTH = 8

/**
 * How many matching files one scan reads before it stops.
 *
 * A number, not a time limit, so the same workspace always produces the same
 * answer on the same machine: the walk is ordered and the cap is counted.
 */
export const SCAN_MAX_FILES = 2000

/**
 * Largest file one scan reads.
 *
 * The search is for a key someone pasted into a source file; a megabyte is
 * already larger than any file that happens to contain one, and reading a
 * generated bundle whole would cost more than the answer is worth.
 */
export const SCAN_MAX_BYTES = 1024 * 1024

/**
 * Directories `scan` walks past.
 *
 * `.git` holds compressed objects rather than the text of a committed file, and
 * `node_modules` is third-party code nobody pastes a key into. Both are large
 * enough that descending into them would dominate the scan.
 */
const SKIPPED_DIRECTORIES: ReadonlySet<string> = new Set(['.git', 'node_modules'])

/** A git command that hangs must not hang the tool call with it. */
const GIT_TIMEOUT_MS = 15_000

/**
 * An assignment line: an optional `export`, a name, `=`, and the value.
 *
 * The whitespace after `=` belongs to the prefix rather than to the value, so a
 * file written `FOO = value` stays `FOO = value` after a `set` — the value is
 * what changes, not the way the line is laid out.
 */
const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=[ 	]*/

/**
 * One line with the terminator that ended it, so joining is byte-exact.
 *
 * A `String.split('\n')` would lose which terminator each line had and turn a
 * CRLF file into an LF one on the first `set`.
 */
interface Line {
  readonly body: string
  readonly end: string
}

/**
 * A file split into lines without normalising its endings.
 *
 * A lone `\r` counts as a line break beside `\r\n` and `\n`: a file saved by an
 * editor that still writes classic-Mac endings would otherwise read as one long
 * line, and a `set` would replace everything after the first `=`.
 */
const LINE = /[^\r\n]*(?:\r\n|\r|\n)|[^\r\n]+$/g

/** One key as `list` reports it: the name and how long the value is. */
export interface EnvKeyEntry {
  readonly name: string
  readonly length: number
}

/** A value `scan` searches the workspace for, with the name it belongs to. */
export interface EnvSecret {
  readonly name: string
  readonly value: string
}

/** One `path:line` where a value was found. The value is not part of it. */
export interface EnvLeak {
  readonly name: string
  readonly path: string
  readonly line: number
}

/** The rewritten text of a `set`, and whether an assignment was already there. */
export interface EnvUpsert {
  readonly text: string
  readonly replaced: boolean
}

/** The rewritten text of an `unset`, and whether anything was removed. */
export interface EnvRemoval {
  readonly text: string
  readonly removed: boolean
}

/** What `check` reports about the file on disk. */
export interface EnvFileState {
  readonly exists: boolean
  /** Permission bits in octal (`"600"`), or `null` where POSIX modes do not exist. */
  readonly mode: string | null
}

/** What `check` reports about the file's standing in git. */
export interface GitState {
  readonly gitignored: boolean
  readonly tracked: boolean
}

/** One scan's findings, and whether the walk stopped early. */
export interface ScanOutcome {
  readonly leaks: readonly EnvLeak[]
  readonly truncated: boolean
}

/**
 * The value of an assignment as a person reads it.
 *
 * Quotes and a trailing comment are not part of the value: `FOO="a b" # note`
 * is `a b`, and a reader who compares that against a pasted string is right
 * while a reader who compares the raw tail is not. No unescaping happens — a
 * `\"` inside a quoted value is left as two characters — because the only uses
 * are a length and a substring search, and inventing a decoder would put a
 * second `.env` implementation in the repo.
 */
export function parseValue(raw: string): string {
  const text = raw.trim()
  const quote = text[0]
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, 1)
    return end === -1 ? text.slice(1) : text.slice(1, end)
  }
  const comment = /\s#/.exec(text)
  return comment === null ? text : text.slice(0, comment.index).trimEnd()
}

/**
 * The keys of a file, in the order a reader meets them, first occurrence only.
 *
 * A duplicated name is one key: `set` keeps exactly one assignment, and a
 * listing that showed the same name twice would suggest otherwise. The last
 * occurrence is what a dotenv reader would use, which is why `set` also drops
 * the duplicates — leaving them would silently defeat the write.
 */
export function readKeys(text: string): readonly EnvKeyEntry[] {
  const seen = new Set<string>()
  const keys: EnvKeyEntry[] = []
  for (const line of splitLines(text)) {
    const assignment = assignmentOf(line.body)
    if (assignment === undefined || seen.has(assignment.name)) continue
    seen.add(assignment.name)
    keys.push({ name: assignment.name, length: parseValue(assignment.value).length })
  }
  return keys
}

/**
 * The values a scan may look for: distinct `name=value` pairs whose value is
 * long enough to be evidence of a leak rather than a coincidence.
 *
 * `name` travels with the value so a hit can be reported by name; two keys that
 * share a value are kept apart, because either of them could be the one that
 * leaked.
 */
export function readSecrets(text: string): readonly EnvSecret[] {
  const seen = new Set<string>()
  const secrets: EnvSecret[] = []
  for (const line of splitLines(text)) {
    const assignment = assignmentOf(line.body)
    if (assignment === undefined) continue
    const value = parseValue(assignment.value)
    if (value.length < MIN_SECRET_LENGTH) continue
    const key = `${assignment.name}\u0000${value}`
    if (seen.has(key)) continue
    seen.add(key)
    secrets.push({ name: assignment.name, value })
  }
  return secrets
}

/**
 * Every line of `text` that contains one of `secrets`, as `path:line`.
 *
 * A plain substring test, not a regex: a value is arbitrary user text and half
 * of it would be regex syntax. Lines are numbered from 1, the way an editor
 * shows them and the way the model will look the leak up.
 */
export function findLeaks(
  path: string,
  text: string,
  secrets: readonly EnvSecret[],
): readonly EnvLeak[] {
  if (secrets.length === 0) return []
  const leaks: EnvLeak[] = []
  const seen = new Set<string>()
  const lines = text.split(/\r\n|\r|\n/)
  for (const [index, line] of lines.entries()) {
    for (const secret of secrets) {
      if (!line.includes(secret.value)) continue
      const key = `${secret.name}\u0000${String(index)}`
      if (seen.has(key)) continue
      seen.add(key)
      leaks.push({ name: secret.name, path, line: index + 1 })
    }
  }
  return leaks
}

/**
 * Set one assignment, keeping every other byte of the file.
 *
 * The first assignment of `name` is rewritten in place from its `=` onward, so
 * the name's own spelling (`export FOO`, `foo =`) survives; a second assignment
 * of the same name is dropped, because a dotenv reader takes the last one and
 * leaving it would make this write a no-op. Without an existing assignment the
 * new line is appended after the file's last line, using the line ending the
 * file already uses — a CRLF file stays a CRLF file.
 */
export function upsertAssignment(text: string, name: string, value: string): EnvUpsert {
  const kept: Line[] = []
  let replaced = false
  for (const line of splitLines(text)) {
    const assignment = assignmentOf(line.body)
    if (assignment === undefined || assignment.name !== name) {
      kept.push(line)
      continue
    }
    if (replaced) continue
    replaced = true
    kept.push({ body: `${assignment.prefix}${value}`, end: line.end })
  }
  if (replaced) return { text: joinLines(kept), replaced: true }

  const ending = lineEndingOf(text)
  const body = text === '' || text.endsWith('\n') ? text : `${text}${ending}`
  return { text: `${body}${name}=${value}${ending}`, replaced: false }
}

/**
 * Remove every assignment of `name` and nothing else.
 *
 * Every assignment, not the first: a duplicate would keep answering the name
 * after an `unset`, which is the one outcome the caller would not expect. The
 * rest of the file is rejoined byte for byte, terminators included.
 */
export function removeAssignment(text: string, name: string): EnvRemoval {
  const kept: Line[] = []
  let removed = false
  for (const line of splitLines(text)) {
    const assignment = assignmentOf(line.body)
    if (assignment !== undefined && assignment.name === name) {
      removed = true
      continue
    }
    kept.push(line)
  }
  return removed ? { text: joinLines(kept), removed: true } : { text, removed: false }
}

/** What `check` needs about the file: whether it is there, and its mode. */
export async function statEnvFile(path: string): Promise<EnvFileState> {
  const info = await stat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) return { exists: false, mode: null }
  // Windows has no POSIX mode bits to report; `chmod` there only toggles the
  // read-only attribute, so an octal string would be an invented fact.
  const mode = process.platform === 'win32' ? null : (info.mode & 0o777).toString(8).padStart(3, '0')
  return { exists: true, mode }
}

/**
 * The file's text, or `undefined` when it is not there.
 *
 * A missing `.env` is the normal first state of a project, not a failure: `list`
 * reports `exists: false` and `set` creates the file. Any other read error is a
 * real one and is reported as `io_failed` with the path in it.
 */
export async function readEnvFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw new EnvKeysError('io_failed', `cannot read ${path}: ${messageOf(error)}`, { cause: error })
  }
}

/**
 * Replace the file's contents in one step.
 *
 * A sibling temp file plus a rename, so a crash or a full disk leaves the old
 * `.env` intact instead of a half-written one — the file is the only copy of
 * keys a person may not have anywhere else. The temp file is created `0600` and
 * the rename carries that mode over; the `chmod` afterwards is for the file that
 * already existed with looser bits, and is best effort: Windows refuses POSIX
 * bits outright and a filesystem without permissions ignores them, while
 * `check` reports the mode that actually stuck.
 */
export async function writeEnvFile(path: string, text: string): Promise<void> {
  const temp = join(
    dirname(path),
    `${basename(path)}.${String(process.pid)}.${randomBytes(4).toString('hex')}.tmp`,
  )
  try {
    await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, path)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined)
    throw new EnvKeysError('io_failed', `cannot write ${path}: ${messageOf(error)}`, { cause: error })
  }
  await chmod(path, 0o600).catch(() => undefined)
}

/**
 * Whether git ignores the file, and whether it is tracked.
 *
 * Both answers are git's, asked with two porcelain commands whose exit code is
 * the answer — no parsing of `status` and no regex over a listing. Outside a
 * work tree (or on a machine without git) both are `false`: there is no honest
 * way to say "ignored" about a file no repository looks at.
 */
export async function gitReport(path: string, workspace: string): Promise<GitState> {
  const inside = await git(['rev-parse', '--is-inside-work-tree'], workspace)
  if (!inside.ok || inside.stdout.trim() !== 'true') return { gitignored: false, tracked: false }
  const target = gitPath(path, workspace)
  const ignored = await git(['check-ignore', '-q', '--', target], workspace)
  const listed = await git(['ls-files', '--', target], workspace)
  return { gitignored: ignored.ok, tracked: listed.ok && listed.stdout.trim() !== '' }
}

/**
 * Walk the workspace and report every file that contains one of `secrets`.
 *
 * The walk is ordered (names sorted per directory) and counted against
 * {@link SCAN_MAX_FILES}, so two runs on the same tree agree on the answer and
 * on `truncated`. Symlinks are not followed and the env file itself is skipped:
 * the value living in `.env` is not a leak.
 */
export async function scanWorkspace(
  workspace: string,
  glob: string,
  secrets: readonly EnvSecret[],
  skip: string,
): Promise<ScanOutcome> {
  const walk: Walk = { paths: [], truncated: false }
  await walkDirectory(workspace, '', glob, walk)

  const leaks: EnvLeak[] = []
  for (const path of walk.paths) {
    const absolute = resolve(workspace, path)
    if (absolute === skip) continue
    const info = await stat(absolute).catch(() => undefined)
    if (info === undefined || info.size > SCAN_MAX_BYTES) continue
    const text = await readFile(absolute, 'utf8').catch(() => undefined)
    // A NUL means the file is not text; searching it would only cost time.
    if (text === undefined || text.includes('\u0000')) continue
    leaks.push(...findLeaks(path, text, secrets))
  }
  return { leaks, truncated: walk.truncated }
}

/** The matching files of a walk, and whether the cap stopped it. */
interface Walk {
  readonly paths: string[]
  truncated: boolean
}

/** Depth-first, names sorted, into directories {@link SKIPPED_DIRECTORIES} allows. */
async function walkDirectory(
  directory: string,
  prefix: string,
  glob: string,
  walk: Walk,
): Promise<void> {
  if (walk.truncated) return
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
    if (entry.isDirectory()) {
      if (SKIPPED_DIRECTORIES.has(entry.name)) continue
      await walkDirectory(join(directory, entry.name), path, glob, walk)
      if (walk.truncated) return
      continue
    }
    // `isFile()` is false for a symlink, which is what keeps the walk finite.
    if (!entry.isFile() || !matchPath(glob, path)) continue
    walk.paths.push(path)
    if (walk.paths.length >= SCAN_MAX_FILES) {
      walk.truncated = true
      return
    }
  }
}

/** One assignment as the pieces a rewrite needs: name, prefix, raw value tail. */
interface Assignment {
  readonly name: string
  /** Everything up to and including the `=`, kept as written. */
  readonly prefix: string
  readonly value: string
}

/** The assignment a line carries, or `undefined` for a comment, blank or malformed line. */
function assignmentOf(body: string): Assignment | undefined {
  const match = ASSIGNMENT.exec(body)
  if (match === null) return undefined
  const name = match[1]
  if (name === undefined) return undefined
  return { name, prefix: body.slice(0, match[0].length), value: body.slice(match[0].length) }
}

/** Split without losing which terminator each line had. */
function splitLines(text: string): readonly Line[] {
  const lines: Line[] = []
  for (const chunk of text.match(LINE) ?? []) {
    if (chunk.endsWith('\r\n')) lines.push({ body: chunk.slice(0, -2), end: '\r\n' })
    else if (chunk.endsWith('\n')) lines.push({ body: chunk.slice(0, -1), end: '\n' })
    else if (chunk.endsWith('\r')) lines.push({ body: chunk.slice(0, -1), end: '\r' })
    else lines.push({ body: chunk, end: '' })
  }
  return lines
}

/** The inverse of {@link splitLines}: every body followed by its own terminator. */
function joinLines(lines: readonly Line[]): string {
  return lines.map((line) => `${line.body}${line.end}`).join('')
}

/**
 * The terminator an appended line should use.
 *
 * Taken from the first line of a file that already has one, so appending to a
 * CRLF file from a POSIX editor does not produce the mixed-endings file that
 * makes every later diff unreadable.
 */
function lineEndingOf(text: string): string {
  return /\r\n|\r|\n/.exec(text)?.[0] ?? '\n'
}

/** The path git should be asked about: relative to the workspace, POSIX-style. */
function gitPath(path: string, workspace: string): string {
  const local = relative(workspace, path)
  const posix = local.split(sep).join('/')
  return isAbsolute(local) || posix.startsWith('../') || posix === '..'
    ? path.split(sep).join('/')
    : posix
}

/** One git question: the exit code is the answer, stdout is the evidence. */
interface GitResult {
  readonly ok: boolean
  readonly stdout: string
}

/**
 * Ask git one question.
 *
 * `execFile`, never a shell: a path with a space or a quote in it must reach git
 * as one argument. A missing git binary, a timeout and a non-zero exit all come
 * back as `ok: false`, because every question here is answered by the exit code
 * and a host without git is not a reason to throw at the model.
 */
function git(args: readonly string[], cwd: string): Promise<GitResult> {
  return new Promise((done) => {
    execFile(
      'git',
      [...args],
      { cwd, encoding: 'utf8', windowsHide: true, timeout: GIT_TIMEOUT_MS },
      (error, stdout) => {
        done({ ok: error === null, stdout })
      },
    )
  })
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
