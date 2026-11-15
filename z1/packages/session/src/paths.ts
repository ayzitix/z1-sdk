/**
 * Where a project's sessions live.
 *
 * The root is deliberately *not* derived from a global default alone: a
 * transcript belongs to the repository it describes, so a fresh repo gets
 * `<repo>/z1/`. Two things can take that slot away — the user setting
 * `Z1_SESSIONS_DIR`, or a `z1/` folder that is already something else (the
 * classic collision: reviewing `z1-sdk` itself, whose repo root *is* the SDK
 * source tree). Both are answered with a different, explicit root rather than
 * by writing sessions into a source tree.
 *
 * @module @z1/session/paths
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { ResolvedSessionRoot, ResolveSessionRootOptions } from './types.ts'

/** Owner marker; its presence means "these sessions are ours". */
export const MARKER_FILE = '.z1-sessions'
export const GITIGNORE_FILE = '.gitignore'
export const SESSIONS_DIR = 'sessions'
export const TRASH_DIR = '.trash'
export const LATEST_FILE = 'latest.json'
export const META_FILE = 'meta.json'
export const EVENTS_FILE = 'events.jsonl'

/** Written on create: the transcript is uncommittable by default. */
const GITIGNORE_CONTENT = '*\n!.gitignore\n'
const MARKER_CONTENT = 'schemaVersion=1\n'

const DIR_MODE = 0o700
const FILE_MODE = 0o600

type Env = Record<string, string | undefined>

function homeOf(env: Env): string {
  const fromEnv = env.HOME?.trim()
  return fromEnv && fromEnv !== '' ? fromEnv : homedir()
}

/** `~/x` — the only shell expansion a path from the environment gets. */
function expandHome(value: string, env: Env): string {
  if (value === '~') return homeOf(env)
  if (value.startsWith('~/')) return join(homeOf(env), value.slice(2))
  return value
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isSessionRoot(dir: string): boolean {
  return existsSync(join(dir, MARKER_FILE)) || isDirectory(join(dir, SESSIONS_DIR))
}

function isEmptyDirectory(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return false
  }
}

function writeIfMissing(file: string, content: string): void {
  if (existsSync(file)) return
  writeFileSync(file, content, { encoding: 'utf8', mode: FILE_MODE })
}

/**
 * Create the root skeleton. Idempotent, so every writer may call it and a
 * deleted project directory heals on the next write.
 */
export function ensureSessionRoot(root: string): void {
  mkdirSync(root, { recursive: true, mode: DIR_MODE })
  writeIfMissing(join(root, MARKER_FILE), MARKER_CONTENT)
  writeIfMissing(join(root, GITIGNORE_FILE), GITIGNORE_CONTENT)
  mkdirSync(join(root, SESSIONS_DIR), { recursive: true, mode: DIR_MODE })
}

/** First ancestor of `cwd` holding `.git`, or `undefined` outside a repo. */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Keep the root out of `git status` without touching a tracked `.gitignore`.
 * `info/exclude` is per-clone, so this is a local convenience, not a contract;
 * failing git (or a root outside the repo) is not an error.
 */
function excludeFromGit(root: string, repoRoot: string): void {
  const rel = relative(repoRoot, root)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return
  const pattern = `/${rel.split(sep).join('/')}/`
  let excludePath: string
  try {
    const gitPath = execFileSync('git', ['rev-parse', '--git-path', 'info/exclude'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (gitPath === '') return
    excludePath = resolve(repoRoot, gitPath)
  } catch {
    return
  }
  const current = existsSync(excludePath) ? readFileSync(excludePath, 'utf8') : ''
  if (current.split('\n').some((line) => line.trim() === pattern)) return
  try {
    mkdirSync(dirname(excludePath), { recursive: true, mode: DIR_MODE })
    const lead = current === '' || current.endsWith('\n') ? '' : '\n'
    appendFileSync(excludePath, `${lead}${pattern}\n`)
  } catch {
    // An exclude entry is a nicety; the root's own .gitignore still applies.
  }
}

/**
 * `true` when `<repo>/z1` can host sessions: it already is a session root, is
 * empty, or does not exist yet and can be created. A populated folder that is
 * not ours (a source tree, a hand-made directory) is left alone.
 */
function claimCandidate(dir: string): boolean {
  if (existsSync(dir)) {
    if (!isDirectory(dir)) return false
    if (isSessionRoot(dir)) return true
    return isEmptyDirectory(dir)
  }
  try {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE })
    return true
  } catch {
    return false
  }
}

/** `<state>/z1/projects/<basename>-<sha1(cwd)[0:8]>/z1` — stable per checkout. */
function fallbackRoot(cwd: string, env: Env): string {
  const key = createHash('sha1').update(cwd).digest('hex').slice(0, 8)
  const name = cwd.split(sep).filter((part) => part !== '').pop() ?? 'root'
  return join(homeOf(env), '.local', 'share', 'z1', 'projects', `${name}-${key}`, 'z1')
}

/**
 * Resolve (and create) the session root for `cwd`.
 *
 * Precedence: `Z1_SESSIONS_DIR` → `<repoRoot>/z1` → per-project fallback under
 * `~/.local/share/z1/projects`. Creating directories here is intentional: the
 * decision itself is "can this folder hold sessions", which needs the folder.
 */
export function resolveSessionRoot(options: ResolveSessionRootOptions): ResolvedSessionRoot {
  const env = options.env ?? process.env
  const cwd = resolve(options.cwd)
  const repoRoot = findRepoRoot(cwd) ?? cwd

  const override = env.Z1_SESSIONS_DIR?.trim()
  if (override !== undefined && override !== '') {
    const root = resolve(cwd, expandHome(override, env))
    ensureSessionRoot(root)
    return { root, mode: 'override', repoRoot }
  }

  const candidate = join(repoRoot, 'z1')
  if (claimCandidate(candidate)) {
    ensureSessionRoot(candidate)
    excludeFromGit(candidate, repoRoot)
    return { root: candidate, mode: 'project', repoRoot }
  }

  const root = fallbackRoot(repoRoot, env)
  ensureSessionRoot(root)
  return { root, mode: 'fallback', repoRoot }
}
