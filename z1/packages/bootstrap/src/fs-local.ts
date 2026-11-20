/**
 * The real-disk `FsService`.
 *
 * This is the ambient `ctx.fs` of a run when `RuntimeConfig.fsMode` is
 * `local`: writes create the parent directory, reads decode UTF-8, and every
 * failure names the path it was about. Module code never reaches this object
 * directly — the worker capability broker (`fs.read`/`fs.write`) still decides
 * which paths a module may touch before calling it.
 *
 * Paths are resolved against the workspace the service was created with, not
 * against `process.cwd()`. A server started from `/` must spill relative paths
 * into the project it serves, and a relative `..` must not climb out of it.
 *
 * @module @z1/bootstrap/fs-local
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import type { FsService } from '@z1/runtime'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export interface LocalFsOptions {
  /**
   * Leave an absolute path exactly as the caller wrote it, even outside the
   * root. Only the module capability broker sets this: it has already resolved
   * the real path against the manifest grants, and a module may legitimately
   * read its own directory outside the workspace. Relative paths are still
   * anchored to the root.
   */
  allowAbsolute?: boolean
}

/**
 * A filesystem service over `node:fs/promises`, contained by `root`.
 *
 * Relative paths are joined to `root`; an absolute path outside it (or a
 * relative one that resolves outside through `..`) is refused rather than
 * silently written somewhere the caller did not mean.
 */
export function createLocalFsService(
  root: string = process.cwd(),
  options: LocalFsOptions = {},
): FsService {
  const base = resolve(root)

  const inside = (path: string): string => {
    if (options.allowAbsolute === true && isAbsolute(path)) return path
    const target = resolve(base, path)
    const rel = relative(base, target)
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`path "${path}" escapes the workspace root "${base}"`)
    }
    return target
  }

  return {
    async read(path: string): Promise<string> {
      try {
        return await readFile(inside(path), 'utf8')
      } catch (error) {
        throw new Error(`cannot read "${path}": ${errorMessage(error)}`)
      }
    },

    async write(path: string, data: string): Promise<void> {
      try {
        const target = inside(path)
        // `dirname('file.txt')` is `.`, so a bare name needs no special case.
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, data, 'utf8')
      } catch (error) {
        throw new Error(`cannot write "${path}": ${errorMessage(error)}`)
      }
    },
  }
}
