import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { loadStaticTemplates } from '../src/index.ts'

let directory = ''

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'z1-template-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

const VALID_GRAPH = { schemaVersion: 1, id: 'hello', nodes: [], edges: [] }

function write(name: string, value: unknown): Promise<void> {
  return writeFile(join(directory, name), JSON.stringify(value), 'utf8')
}

function errorOf(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected the call to throw')
}

describe('loadStaticTemplates', () => {
  test('loads every *.json template in the directory', async () => {
    await write('a.json', {
      id: 'alpha',
      version: '1.0.0',
      title: 'Alpha',
      description: 'first',
      graph: VALID_GRAPH,
    })
    await write('b.json', { id: 'beta', version: '2.0.0', title: 'Beta', graph: VALID_GRAPH })
    await writeFile(join(directory, 'notes.txt'), 'ignored', 'utf8')

    const templates = loadStaticTemplates(directory)

    expect(templates.map((template) => template.id)).toEqual(['alpha', 'beta'])
    expect(templates[0]).toMatchObject({ kind: 'static', description: 'first' })
    expect(templates[0]?.graph?.id).toBe('hello')
    expect(templates[0]?.graph?.nodes).toEqual([])
  })

  test('a missing directory is no templates', () => {
    expect(loadStaticTemplates(join(directory, 'absent'))).toEqual([])
  })

  test('an invalid graph file names the file and the problem', async () => {
    await write('broken.json', {
      id: 'broken',
      version: '1.0.0',
      title: 'Broken',
      graph: { schemaVersion: 1 },
    })

    const message = errorOf(() => loadStaticTemplates(directory))

    expect(message).toContain('broken.json')
    expect(message).toMatch(/invalid graph document/)
    expect(message).toContain('nodes')
  })

  test('a file without template metadata is rejected', async () => {
    await write('meta.json', { version: '1.0.0', title: 'No id', graph: VALID_GRAPH })

    const message = errorOf(() => loadStaticTemplates(directory))

    expect(message).toContain('meta.json')
    expect(message).toMatch(/id must be a non-empty string/)
  })

  test('invalid JSON names the file', async () => {
    await writeFile(join(directory, 'bad.json'), '{ nope', 'utf8')

    expect(errorOf(() => loadStaticTemplates(directory))).toMatch(/bad\.json.*not valid JSON/)
  })
})
