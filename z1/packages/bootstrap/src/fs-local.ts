/**
 * The real-disk `FsService`.
 *
 * This is the ambient `ctx.fs` of a run when `RuntimeConfig.fsMode` is
 * `local`: writes create the parent directory, reads decode UTF-8, and every
 * failure names the path it was about. Module code never reaches this object
 * directly — the worker capability broker (`fs.read`/`fs.write`) still decides
 * which paths a module may touch before calling it.
 *
 * @module @z1/bootstrap/fs-local
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { FsService } from '@z1/runtime'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A filesystem service over `node:fs/promises`, rooted nowhere in particular. */
export function createLocalFsService(): FsService {
  return {
    async read(path: string): Promise<string> {
      try {
        return await readFile(path, 'utf8')
      } catch (error) {
        throw new Error(`cannot read "${path}": ${errorMessage(error)}`)
      }
    },

    async write(path: string, data: string): Promise<void> {
      try {
        // `dirname('file.txt')` is `.`, so a bare name needs no special case.
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, data, 'utf8')
      } catch (error) {
        throw new Error(`cannot write "${path}": ${errorMessage(error)}`)
      }
    },
  }
}
