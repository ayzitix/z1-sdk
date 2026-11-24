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
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
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
/** Held (created with `wx`) while a writer mutates one session. */
export const LOCK_FILE = '.lock'

/** `.trash` entries kept regardless of age. */
export const TRASH_KEEP = 50
/** Age after which a `.trash` entry is dropped whatever its position. */
export const TRASH_KEEP_MS = 30 * 24 * 60 * 60 * 1000

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
  // Only the owner marker makes a directory ours. A bare `sessions/` can be a
  // project's own fixtures or game saves; claiming it would rewrite their tree.
  return existsSync(join(dir, MARKER_FILE))
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
  // `mkdir`/`write` modes only apply on creation; a copied or older tree can be
  // world-readable. Enforce the private modes on every open.
  try {
    chmodSync(root, DIR_MODE)
    chmodSync(join(root, SESSIONS_DIR), DIR_MODE)
    chmodSync(join(root, MARKER_FILE), FILE_MODE)
    chmodSync(join(root, GITIGNORE_FILE), FILE_MODE)
  } catch {
    // A read-only or exotic filesystem may refuse; the caller still gets a root.
  }
}

/** Options for {@link pruneTrash}; every field has a default. */
export interface PruneTrashOptions {
  /**
   * Entries this call must not delete: a trash entry name, a path inside the
   * trash, or the session id a `remove` name ends with (`-<id>`). `remove`
   * passes the entry it has just moved here, because neither the position nor
   * the age of that entry is trustworthy: on a coarse filesystem, or after a
   * clock that jumped backwards, its `<stamp>-<id>` name and its mtime both
   * sort it as the oldest thing in the trash.
   */
  protect?: Iterable<string>
  /** Entries kept regardless of age. Default {@link TRASH_KEEP}. */
  keep?: number
  /** Maximum age in milliseconds. Default {@link TRASH_KEEP_MS}. */
  keepMs?: number
  /** Clock, injectable for tests. Default `Date.now`. */
  now?: number
}

/**
 * Drop `.trash` entries that fell out of the retention window.
 *
 * `remove` is a soft delete — the directory moves instead of disappearing — but
 * nothing ever emptied `.trash`, so a store used for months grew without a
 * bound. The window is deliberately modest: the newest {@link TRASH_KEEP}
 * entries survive for at most {@link TRASH_KEEP_MS}, whichever is reached
 * first, which is enough to recover a session deleted by mistake. Everything
 * here is best effort — a missing, unreadable or half-deleted trash is not an
 * error, because pruning must never make `remove` fail.
 *
 * A protected entry is never deleted and still occupies a slot: it displaces
 * the oldest unprotected entry instead, so the window holds at most `keep`
 * entries. Age is `now - mtime`, and a negative age — an mtime in the future,
 * which is what a clock that jumped backwards produces — is fresh, never old.
 *
 * Returns the names of the entries it deleted, newest first, for the caller's
 * log.
 */
export function pruneTrash(root: string, options: PruneTrashOptions = {}): readonly string[] {
  const keep = Math.max(0, Math.floor(options.keep ?? TRASH_KEEP))
  const keepMs = Math.max(0, options.keepMs ?? TRASH_KEEP_MS)
  const now = options.now ?? Date.now()
  const dir = join(root, TRASH_DIR)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const entries: { name: string; mtimeMs: number }[] = []
  for (const name of names) {
    try {
      entries.push({ name, mtimeMs: statSync(join(dir, name)).mtimeMs })
    } catch {
      // Vanished between the scan and the stat: nothing left to keep.
    }
  }
  // Newest first, name as the tie-break, so entries written in the same
  // millisecond are pruned in a stable order.
  entries.sort((left, right) =>
    right.mtimeMs === left.mtimeMs
      ? right.name.localeCompare(left.name)
      : right.mtimeMs - left.mtimeMs,
  )
  const protect = options.protect === undefined ? [] : [...options.protect]
  const isProtected = (name: string): boolean => {
    for (const key of protect) {
      // A name, a path inside this trash, or the session id a `remove` name
      // ends with. `remove` knows the id, not the `<stamp>-<id>` trash name.
      if (key === name || key === join(dir, name) || name.endsWith(`-${key}`)) return true
    }
    return false
  }
  // Protected entries never pay for their own slot: they take one from the
  // window and push out the oldest unprotected entry instead, so a trash that
  // was full before the write still ends up holding `keep` entries.
  let budget = Math.max(0, keep - entries.filter((entry) => isProtected(entry.name)).length)
  const removed: string[] = []
  for (const entry of entries) {
    if (isProtected(entry.name)) continue
    // A negative age means the mtime is in the future — a clock that jumped
    // backwards — and such an entry is fresh, never old.
    const tooOld = now - entry.mtimeMs > keepMs
    if (!tooOld && budget > 0) {
      budget -= 1
      continue
    }
    try {
      rmSync(join(dir, entry.name), { recursive: true, force: true })
      removed.push(entry.name)
    } catch {
      // A Windows handle still holds it; the next prune tries again.
    }
  }
  return removed
}

/** First ancestor of `cwd` holding `.git`, or `undefined` outside a repo. */
export function findRepoRoot(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    const git = join(dir, '.git')
    if (isDirectory(git)) return dir
    try {
      // A worktree has a `.git` file with `gitdir: <path>`; a random file with
      // that name is not a repository and must not capture the session root.
      if (readFileSync(git, 'utf8').trimStart().startsWith('gitdir:')) return dir
    } catch {
      // No `.git` here.
    }
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
  // A newline would inject another line into .git/info/exclude; a glob
  // character would make the pattern match something else (or nothing).
  if (/[\u0000\n\r]/.test(rel)) return
  const escaped = rel
    .split(sep)
    .map((part) => part.replace(/[\\*?\[\]!# ]/g, (char) => `\\${char}`))
    .join('/')
  const pattern = `/${escaped}/`
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
  const override = env.XDG_DATA_HOME?.trim()
  const dataHome =
    override !== undefined && override !== ''
      ? resolve(expandHome(override, env))
      : join(homeOf(env), '.local', 'share')
  return join(dataHome, 'z1', 'projects', `${name}-${key}`, 'z1')
}

/**
 * Resolve (and create) the session root for `cwd`.
 *
 * Precedence: `Z1_SESSIONS_DIR` → `<repoRoot>/z1` → per-project fallback under
 * `~/.local/share/z1/projects`. Creating directories here is intentional: the
 * decision itself is "can this folder hold sessions", which needs the folder.
 *
 * The override is a *claim*, exactly like `<repoRoot>/z1`: it is accepted only
 * when it already is a session root (marker), is empty, or does not exist yet.
 * A populated foreign directory (`Z1_SESSIONS_DIR=.`, a notes folder, a source
 * tree) is never chmod'ed, never given a `.gitignore`, and never written into;
 * the store falls back to the per-project directory and says why through
 * `onWarning` and {@link ResolvedSessionRoot.warning}.
 */
export function resolveSessionRoot(options: ResolveSessionRootOptions): ResolvedSessionRoot {
  const env = options.env ?? process.env
  const cwd = resolve(options.cwd)
  const repoRoot = findRepoRoot(cwd) ?? cwd

  const override = env.Z1_SESSIONS_DIR?.trim()
  if (override !== undefined && override !== '') {
    const candidate = resolve(cwd, expandHome(override, env))
    if (claimCandidate(candidate)) {
      ensureSessionRoot(candidate)
      // An override inside the repository must not dirty `git status` either.
      excludeFromGit(candidate, repoRoot)
      return { root: candidate, mode: 'override', repoRoot }
    }
    const root = fallbackRoot(repoRoot, env)
    ensureSessionRoot(root)
    const warning =
      `Z1_SESSIONS_DIR=${candidate} is a populated directory that is not a z1 session root; ` +
      `refusing to claim it (no chmod, no .gitignore) and using ${root} instead`
    options.onWarning?.(warning)
    return { root, mode: 'fallback', repoRoot, warning }
  }

  const candidate = join(repoRoot, 'z1')
  if (claimCandidate(candidate)) {
    try {
      ensureSessionRoot(candidate)
      excludeFromGit(candidate, repoRoot)
      return { root: candidate, mode: 'project', repoRoot }
    } catch {
      // A read-only checkout can have an empty/owned z1/ but no writable files.
      // Fall through to the per-project data directory instead of failing boot.
    }
  }

  const root = fallbackRoot(repoRoot, env)
  ensureSessionRoot(root)
  return { root, mode: 'fallback', repoRoot }
}
