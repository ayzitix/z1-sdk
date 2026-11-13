import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { createRuntime, loadRuntimeConfig, type Runtime } from '../src/index.ts'

let root = ''
const runtimes: Runtime[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'z1-bootstrap-templates-'))
})

afterAll(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close()
  await rm(root, { recursive: true, force: true })
})

async function makeRuntime(name: string, templatesPath?: string): Promise<Runtime> {
  const runtime = await createRuntime(
    loadRuntimeConfig({
      cwd: root,
      env: {},
      overrides: {
        dbPath: join(root, `${name}.db`),
        graphsPath: join(root, `${name}-graphs`),
        modulesPath: join(root, `${name}-modules`),
        templatesPath: templatesPath ?? join(root, `${name}-templates`),
      },
    }),
  )
  runtimes.push(runtime)
  return runtime
}

test('templatesPath precedence is env > file > default', async () => {
  const file = join(root, 'templates.config.json')
  await writeFile(file, JSON.stringify({ templatesPath: 'file-templates' }), 'utf8')

  const defaults = loadRuntimeConfig({ cwd: root, env: {} })
  expect(defaults.templatesPath).toBe(join(resolve(root), '.z1/templates'))

  const fromFile = loadRuntimeConfig({ cwd: root, env: {}, file })
  expect(fromFile.templatesPath).toBe(join(resolve(root), 'file-templates'))

  const fromEnv = loadRuntimeConfig({
    cwd: root,
    env: { Z1_TEMPLATES_DIR: 'env-templates' },
    file,
  })
  expect(fromEnv.templatesPath).toBe(join(resolve(root), 'env-templates'))

  await rm(file)
})

test('the runtime always lists the built-in agent loop', async () => {
  const runtime = await makeRuntime('agent')

  expect(runtime.templates.list().map((template) => template.id)).toContain('agent.loop')
  expect(runtime.templates.build('agent.loop').id).toBe('agent.loop')
})

test('a static template in templatesPath is loadable through the runtime', async () => {
  const templatesPath = join(root, 'static-templates')
  await mkdir(templatesPath, { recursive: true })
  await writeFile(
    join(templatesPath, 'hello.json'),
    JSON.stringify({
      id: 'hello.static',
      version: '1.0.0',
      title: 'Static hello',
      graph: { schemaVersion: 1, id: 'hello', nodes: [], edges: [] },
    }),
    'utf8',
  )

  const runtime = await makeRuntime('static', templatesPath)

  const template = runtime.templates.get('hello.static')
  expect(template?.kind).toBe('static')
  const built = runtime.templates.build('hello.static')
  expect(built.id).toBe('hello')
  expect(built).not.toBe(template?.graph)
})
