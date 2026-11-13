import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ModuleManifest } from '../src/types.ts'

export function manifest(overrides: Partial<ModuleManifest> = {}): ModuleManifest {
  return {
    schemaVersion: 1,
    id: 'com.example.echo',
    version: '1.0.0',
    title: 'Echo',
    license: 'MIT',
    engines: { z1: '>=0.1.0' },
    entry: 'index.js',
    nodes: [
      {
        id: 'com.example.echo.run',
        version: '1.0.0',
        title: 'Echo',
        category: 'transform',
        inputs: [{ kind: 'data', id: 'text', schema: { type: 'string' }, required: true }],
        outputs: [{ kind: 'data', id: 'text', schema: { type: 'string' } }],
      },
    ],
    capabilities: {
      fs: { read: ['${moduleDir}/data/**'] },
      net: { hosts: ['api.example.com'] },
    },
    ...overrides,
  }
}

/** Write a minimal runnable-looking module directory (no code is executed). */
export function writeModule(
  directory: string,
  options: { manifest?: ModuleManifest; files?: Record<string, string> } = {},
): void {
  mkdirSync(directory, { recursive: true })
  const value = options.manifest ?? manifest()
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(value, null, 2))
  writeFileSync(join(directory, 'index.js'), 'export default {}\n')
  mkdirSync(join(directory, 'data'), { recursive: true })
  writeFileSync(join(directory, 'data', 'note.txt'), 'hello\n')

  for (const [name, content] of Object.entries(options.files ?? {})) {
    const target = join(directory, name)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, content)
  }
}
