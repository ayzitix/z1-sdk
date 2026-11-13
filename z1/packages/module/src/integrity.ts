import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { manifestDigest } from './manifest.ts'
import type { ModuleManifest } from './types.ts'

/** Names skipped by the integrity walk and by the proposal copy. */
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.git'])

export interface IntegrityFile {
  /** Path relative to the module root, always with POSIX separators. */
  path: string
  size: number
  sha256: string
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function shouldSkipFile(name: string): boolean {
  return name.endsWith('.log')
}

function toPosixPath(path: string): string {
  return path.split(sep).join('/')
}

/**
 * Recursively collect the files that make up a module payload. `node_modules`,
 * `.git` and `*.log` are excluded because they are either build artefacts or
 * runtime noise that must not change a module's identity.
 */
export function walkIntegrityFiles(root: string): IntegrityFile[] {
  const files: IntegrityFile[] = []

  const visit = (directory: string): void => {
    const entries = readdirSync(directory, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(directory, entry.name)
      const stats = lstatSync(full)
      if (stats.isSymbolicLink()) {
        throw new Error(`module payload must not contain symbolic links: ${full}`)
      }
      if (stats.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        visit(full)
        continue
      }
      if (!stats.isFile() || shouldSkipFile(entry.name)) continue

      const data = readFileSync(full)
      files.push({
        path: toPosixPath(relative(root, full)),
        size: data.byteLength,
        sha256: sha256Hex(data),
      })
    }
  }

  visit(root)
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return files
}

/**
 * Content digest of a module directory. Each file contributes
 * `path\0size\0sha256`; the manifest digest is folded in as a final line so a
 * manifest-only edit (for example widened capabilities) changes integrity even
 * though the file list does not.
 */
export function directoryIntegrity(root: string, manifest: ModuleManifest): string {
  const lines = walkIntegrityFiles(root).map(
    (file) => `${file.path}\0${file.size}\0${file.sha256}`,
  )
  lines.push(`manifest\0${manifestDigest(manifest)}`)
  return sha256Hex(lines.join('\n'))
}

/** Copy a module payload, applying the same exclusions as the integrity walk. */
export function copyPayload(source: string, target: string): void {
  mkdirSync(target, { recursive: true })

  const visit = (from: string, to: string): void => {
    const entries = readdirSync(from, { withFileTypes: true })
    for (const entry of entries) {
      const fromPath = join(from, entry.name)
      const toPath = join(to, entry.name)
      const stats = lstatSync(fromPath)
      if (stats.isSymbolicLink()) {
        throw new Error(`module payload must not contain symbolic links: ${fromPath}`)
      }
      if (stats.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(entry.name)) continue
        mkdirSync(toPath, { recursive: true })
        visit(fromPath, toPath)
        continue
      }
      if (stats.isFile() && !shouldSkipFile(entry.name)) {
        copyFileSync(fromPath, toPath)
      }
    }
  }

  visit(source, target)
}
