import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterAll, beforeAll, expect, test } from 'vitest'

import {
  DEFAULT_CONFIG,
  loadRuntimeConfig,
  type RuntimeConfig,
} from '../src/index.ts'

let directory: string

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'z1-config-'))
})

afterAll(async () => {
  await rm(directory, { recursive: true, force: true })
})

function writeConfig(file: string, value: unknown): Promise<void> {
  return writeFile(file, JSON.stringify(value), 'utf8')
}

test('defaults resolve the relative paths against cwd', () => {
  const config = loadRuntimeConfig({ cwd: directory, env: {} })

  expect(config).toEqual({
    cwd: resolve(directory),
    fsMode: 'local',
    dbPath: join(resolve(directory), DEFAULT_CONFIG.dbPath),
    graphsPath: join(resolve(directory), DEFAULT_CONFIG.graphsPath),
    modulesPath: join(homedir(), '.z1', 'modules'),
    templatesPath: join(resolve(directory), DEFAULT_CONFIG.templatesPath),
    live: false,
    useModules: true,
    useServiceModules: true,
    useMemory: true,
    providers: [
      {
        id: 'river',
        protocol: 'openai-completions',
        envKey: 'RIVER_API_KEY',
        baseURL: 'https://api.river.ai/v1',
      },
      {
        id: 'openai',
        protocol: 'openai-completions',
        envKey: 'OPENAI_API_KEY',
        baseURL: 'https://api.openai.com/v1',
      },
    ],
    env: {},
  } satisfies RuntimeConfig)
})

test('a config file supplies paths, flags and providers', async () => {
  const file = join(directory, 'file.json')
  await writeConfig(file, {
    dbPath: 'state/runs.db',
    graphsPath: 'state/graphs',
    modulesPath: '~/.z1/custom-modules',
    live: true,
    useModules: false,
    useServiceModules: false,
    useMemory: false,
    providers: [
      { id: 'river', envKey: 'LOCAL_RIVER', baseURL: 'https://river.local/v1' },
      { id: 'local', envKey: 'LOCAL_KEY', baseURL: 'https://local/v1' },
    ],
  })

  const config = loadRuntimeConfig({ cwd: directory, env: {}, file })

  expect(config.dbPath).toBe(join(resolve(directory), 'state/runs.db'))
  expect(config.graphsPath).toBe(join(resolve(directory), 'state/graphs'))
  expect(config.modulesPath).toBe(join(homedir(), '.z1', 'custom-modules'))
  expect(config.live).toBe(true)
  expect(config.useModules).toBe(false)
  expect(config.useServiceModules).toBe(false)
  expect(config.useMemory).toBe(false)
  // The file replaces a default of the same id where it was, and appends.
  expect(config.providers.map((provider) => provider.id)).toEqual(['river', 'openai', 'local'])
  expect(config.providers[0]).toMatchObject({ envKey: 'LOCAL_RIVER' })
})

test('the environment beats the file, overrides beat the environment', async () => {
  const file = join(directory, 'precedence.json')
  await writeConfig(file, { dbPath: 'from-file.db', graphsPath: 'from-file-graphs' })

  const fromEnv = loadRuntimeConfig({
    cwd: directory,
    env: {
      Z1_DB: 'from-env.db',
      Z1_GRAPHS_DIR: 'env-graphs',
      Z1_MODULES_DIR: 'env-modules',
      Z1_LIVE: '1',
      Z1_SERVICE_MODULES: '0',
    },
    file,
  })
  expect(fromEnv.dbPath).toBe(join(resolve(directory), 'from-env.db'))
  expect(fromEnv.graphsPath).toBe(join(resolve(directory), 'env-graphs'))
  expect(fromEnv.modulesPath).toBe(join(resolve(directory), 'env-modules'))
  expect(fromEnv.live).toBe(true)
  expect(fromEnv.useServiceModules).toBe(false)

  const overridden = loadRuntimeConfig({
    cwd: directory,
    env: { Z1_DB: 'from-env.db', Z1_LIVE: '1' },
    file,
    overrides: { dbPath: 'override.db', live: false, useMemory: false },
  })
  expect(overridden.dbPath).toBe(join(resolve(directory), 'override.db'))
  expect(overridden.live).toBe(false)
  expect(overridden.useMemory).toBe(false)
})

test('Z1_FS selects the filesystem backend; env beats file, overrides beat env', async () => {
  const file = join(directory, 'fs-mode.json')
  await writeConfig(file, { fsMode: 'memory' })

  expect(loadRuntimeConfig({ cwd: directory, env: {}, file }).fsMode).toBe('memory')
  expect(
    loadRuntimeConfig({ cwd: directory, env: { Z1_FS: 'local' }, file }).fsMode,
  ).toBe('local')
  expect(
    loadRuntimeConfig({
      cwd: directory,
      env: { Z1_FS: 'local' },
      file,
      overrides: { fsMode: 'memory' },
    }).fsMode,
  ).toBe('memory')
  expect(() => loadRuntimeConfig({ cwd: directory, env: { Z1_FS: 'disk' } })).toThrow(
    /Z1_FS must be "local" or "memory"/,
  )

  const bad = join(directory, 'fs-mode-bad.json')
  await writeConfig(bad, { fsMode: 'disk' })
  expect(() => loadRuntimeConfig({ cwd: directory, env: {}, file: bad })).toThrow(
    /fsMode must be "local" or "memory"/,
  )
})

test('~ expands to the home directory', () => {
  const config = loadRuntimeConfig({
    cwd: directory,
    env: { Z1_DB: '~/z1/runs.db' },
  })

  expect(config.dbPath).toBe(join(homedir(), 'z1', 'runs.db'))
  expect(config.graphsPath).toBe(join(resolve(directory), DEFAULT_CONFIG.graphsPath))
})

test('an unknown config key is rejected', async () => {
  const file = join(directory, 'unknown.json')
  await writeConfig(file, { dbPath: 'runs.db', modulezPath: 'typo' })

  expect(() => loadRuntimeConfig({ cwd: directory, env: {}, file })).toThrow(
    /unknown key "modulezPath"/,
  )
})

test('Z1_LIVE only accepts 1 or 0', () => {
  expect(() => loadRuntimeConfig({ cwd: directory, env: { Z1_LIVE: 'yes' } })).toThrow(
    /Z1_LIVE must be 1 or 0/,
  )
})

test('Z1_USE_MODULES and Z1_USE_MEMORY switch features off', () => {
  const config = loadRuntimeConfig({
    cwd: directory,
    env: { Z1_USE_MODULES: 'false', Z1_USE_MEMORY: '0' },
  })

  expect(config.useModules).toBe(false)
  expect(config.useMemory).toBe(false)
  // Untouched switches keep their default.
  expect(config.useServiceModules).toBe(true)
})

test('Z1_SERVICE_MODULES accepts true, false, 1 and 0', () => {
  for (const [raw, expected] of [
    ['true', true],
    ['1', true],
    ['false', false],
    ['0', false],
  ] as const) {
    const config = loadRuntimeConfig({
      cwd: directory,
      env: { Z1_SERVICE_MODULES: raw },
    })
    expect(config.useServiceModules).toBe(expected)
  }

  expect(() =>
    loadRuntimeConfig({ cwd: directory, env: { Z1_SERVICE_MODULES: 'maybe' } }),
  ).toThrow(/Z1_SERVICE_MODULES must be 1, 0, true or false/)
})

test('a config file listing the same provider twice is rejected', async () => {
  const file = join(directory, 'duplicate-provider.json')
  await writeConfig(file, {
    providers: [
      { id: 'local', envKey: 'LOCAL_KEY', baseURL: 'https://local/v1' },
      { id: 'local', envKey: 'OTHER_KEY', baseURL: 'https://other/v1' },
    ],
  })

  expect(() => loadRuntimeConfig({ cwd: directory, env: {}, file })).toThrow(
    /lists provider "local" more than once/,
  )
})

test('an unknown key inside a provider object is rejected', async () => {
  const file = join(directory, 'unknown-provider-key.json')
  await writeConfig(file, {
    providers: [{ id: 'local', envKey: 'LOCAL_KEY', baseURL: 'https://local/v1', model: 'x' }],
  })

  expect(() => loadRuntimeConfig({ cwd: directory, env: {}, file })).toThrow(
    /unknown key "model"; expected id, protocol, envKey, baseURL, headers/,
  )
})

test('overrides can supply providers directly', () => {
  const config = loadRuntimeConfig({
    cwd: directory,
    env: {},
    overrides: {
      providers: [{ id: 'solo', envKey: 'SOLO_KEY', baseURL: 'https://solo/v1' }],
    },
  })

  expect(config.providers).toEqual([
    { id: 'solo', envKey: 'SOLO_KEY', baseURL: 'https://solo/v1' },
  ])
})
