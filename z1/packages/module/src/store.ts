import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { AuditLog } from './audit.ts'
import type { AuditEntry } from './audit.ts'
import { canonicalJson } from './canonical.ts'
import { copyPayload, directoryIntegrity } from './integrity.ts'
import { compareVersions, ModuleManifestError, parseManifest } from './manifest.ts'
import { writeFileAtomic } from './fsutil.ts'
import type { ModuleCapabilities, ModuleManifest } from './types.ts'

/** Accepted manifest file names, in precedence order. */
export const MODULE_MANIFEST_FILES = ['z1.module.json', 'manifest.json'] as const

export interface ModuleGrant {
  moduleId: string
  version: string
  integrity: string
  capabilities: ModuleCapabilities
  grantedAt: number
  futureVersions: boolean
}

export interface InstalledModule {
  manifest: ModuleManifest
  integrity: string
  directory: string
  active: boolean
  installedAt: number
  grant: ModuleGrant
}

export interface ProposedModule {
  manifest: ModuleManifest
  directory: string
  integrity: string
  proposedAt: number
}

export type ModuleStoreErrorCode =
  | 'not-a-directory'
  | 'invalid-manifest'
  | 'entry-missing'
  | 'integrity-conflict'
  | 'not-proposed'
  | 'not-installed'
  | 'corrupt-installed'
  | 'corrupt-state'

export class ModuleStoreError extends Error {
  readonly code: ModuleStoreErrorCode

  constructor(code: ModuleStoreErrorCode, message: string) {
    super(message)
    this.name = 'ModuleStoreError'
    this.code = code
  }
}

interface InstalledRecord {
  manifest: ModuleManifest
  integrity: string
  installedAt: number
}

interface StoreState {
  active: Record<string, string>
  grants: ModuleGrant[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function toGrant(value: unknown): ModuleGrant | undefined {
  if (!isRecord(value)) return undefined
  const { moduleId, version, integrity, capabilities, grantedAt, futureVersions } = value
  if (typeof moduleId !== 'string' || moduleId.length === 0) return undefined
  if (typeof version !== 'string' || version.length === 0) return undefined
  if (typeof integrity !== 'string' || integrity.length === 0) return undefined
  if (typeof grantedAt !== 'number' || !Number.isFinite(grantedAt)) return undefined
  if (typeof futureVersions !== 'boolean') return undefined
  if (!isRecord(capabilities)) return undefined
  return {
    moduleId,
    version,
    integrity,
    capabilities: capabilities as ModuleCapabilities,
    grantedAt,
    futureVersions,
  }
}

/**
 * Byte-for-byte content of the `package.json` added to a module payload that
 * has none. It makes the entry (and any relative imports) unambiguously ESM
 * inside an arbitrary install root.
 */
export const MODULE_PACKAGE_JSON = '{"type":"module"}\n'

/** Add the ESM marker to a copied payload, before it is hashed. Idempotent. */
function ensureModuleType(directory: string): boolean {
  const file = join(directory, 'package.json')
  if (existsSync(file)) return false
  writeFileSync(file, MODULE_PACKAGE_JSON, 'utf8')
  return true
}

function readManifestFromDirectory(directory: string): ModuleManifest {
  for (const name of MODULE_MANIFEST_FILES) {
    const file = join(directory, name)
    if (!existsSync(file)) continue

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new ModuleManifestError([{ path: name, message: 'manifest is not valid JSON' }])
    }
    return parseManifest(raw)
  }

  throw new ModuleStoreError(
    'invalid-manifest',
    `no ${MODULE_MANIFEST_FILES.join(' or ')} in ${directory}`,
  )
}

function directories(directory: string): string[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name)
    .sort()
}

function newer(a: string, b: string): boolean {
  return compareVersions(a, b) > 0
}

/**
 * Local module store. Proposals are inert until approved; installed versions
 * are immutable and only one version per module is active at a time.
 */
export class ModuleStore {
  private readonly root: string
  private readonly proposalsDir: string
  private readonly modulesDir: string
  private readonly statePath: string
  private readonly auditLog: AuditLog
  private state: StoreState

  constructor(root: string) {
    this.root = resolve(root)
    this.proposalsDir = join(this.root, 'proposals')
    this.modulesDir = join(this.root, 'modules')
    this.statePath = join(this.root, 'state.json')
    this.auditLog = new AuditLog(join(this.root, 'audit.jsonl'))
    this.state = this.loadState()
  }

  private loadState(): StoreState {
    if (!existsSync(this.statePath)) return { active: {}, grants: [] }

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(this.statePath, 'utf8'))
    } catch {
      throw new ModuleStoreError('corrupt-state', `state file is not valid JSON: ${this.statePath}`)
    }
    if (!isRecord(raw)) {
      throw new ModuleStoreError('corrupt-state', `state file is not an object: ${this.statePath}`)
    }

    const active: Record<string, string> = {}
    const activeRaw = raw['active']
    if (isRecord(activeRaw)) {
      for (const [moduleId, version] of Object.entries(activeRaw)) {
        if (typeof version === 'string') active[moduleId] = version
      }
    }

    const grants: ModuleGrant[] = []
    const grantsRaw = raw['grants']
    if (Array.isArray(grantsRaw)) {
      for (const value of grantsRaw) {
        const grant = toGrant(value)
        if (grant !== undefined) grants.push(grant)
      }
    }

    return { active, grants }
  }

  private saveState(): void {
    const payload = {
      schemaVersion: 1,
      active: this.state.active,
      grants: this.state.grants,
    }
    writeFileAtomic(this.statePath, `${JSON.stringify(payload, null, 2)}\n`)
  }

  private findGrant(moduleId: string, version: string): ModuleGrant | undefined {
    return this.state.grants.find(
      (grant) => grant.moduleId === moduleId && grant.version === version,
    )
  }

  private persistGrant(
    moduleId: string,
    version: string,
    integrity: string,
    input: Pick<ModuleGrant, 'capabilities' | 'futureVersions'>,
  ): ModuleGrant {
    const index = this.state.grants.findIndex(
      (grant) => grant.moduleId === moduleId && grant.version === version,
    )

    if (index !== -1) {
      const existing = this.state.grants[index]
      if (existing === undefined) {
        throw new ModuleStoreError('corrupt-state', 'grant index vanished')
      }
      if (existing.integrity !== integrity) {
        throw new ModuleStoreError(
          'integrity-conflict',
          `grant for ${moduleId}@${version} covers integrity ${existing.integrity}, not ${integrity}`,
        )
      }
      const unchanged =
        existing.futureVersions === input.futureVersions &&
        canonicalJson(existing.capabilities) === canonicalJson(input.capabilities)
      if (unchanged) return existing

      const updated: ModuleGrant = {
        ...existing,
        capabilities: input.capabilities,
        futureVersions: input.futureVersions,
      }
      this.state.grants = this.state.grants.map((grant, at) => (at === index ? updated : grant))
      this.saveState()
      return updated
    }

    const grant: ModuleGrant = {
      moduleId,
      version,
      integrity,
      capabilities: input.capabilities,
      grantedAt: Date.now(),
      futureVersions: input.futureVersions,
    }
    this.state.grants.push(grant)
    this.saveState()
    return grant
  }

  private installedDirectory(moduleId: string, version: string): string {
    return join(this.modulesDir, moduleId, version)
  }

  private readInstalledRecord(moduleId: string, version: string): InstalledRecord {
    const file = join(this.installedDirectory(moduleId, version), 'installed.json')
    if (!existsSync(file)) {
      throw new ModuleStoreError(
        'not-installed',
        `module ${moduleId}@${version} is not installed`,
      )
    }

    let raw: unknown
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      throw new ModuleStoreError('corrupt-installed', `installed.json is not valid JSON: ${file}`)
    }
    if (!isRecord(raw)) {
      throw new ModuleStoreError('corrupt-installed', `installed.json is not an object: ${file}`)
    }

    const manifest = parseManifest(raw['manifest'])
    const integrity = raw['integrity']
    const installedAt = raw['installedAt']
    if (typeof integrity !== 'string' || integrity.length === 0) {
      throw new ModuleStoreError('corrupt-installed', `installed.json has no integrity: ${file}`)
    }
    if (typeof installedAt !== 'number' || !Number.isFinite(installedAt)) {
      throw new ModuleStoreError('corrupt-installed', `installed.json has no installedAt: ${file}`)
    }
    return { manifest, integrity, installedAt }
  }

  private toInstalled(record: InstalledRecord, grant: ModuleGrant): InstalledModule {
    const { id: moduleId, version } = record.manifest
    return {
      manifest: record.manifest,
      integrity: record.integrity,
      directory: this.installedDirectory(moduleId, version),
      active: this.state.active[moduleId] === version,
      installedAt: record.installedAt,
      grant,
    }
  }

  list(): readonly InstalledModule[] {
    const modules: InstalledModule[] = []

    for (const moduleId of directories(this.modulesDir)) {
      const moduleRoot = join(this.modulesDir, moduleId)
      for (const version of directories(moduleRoot)) {
        const record = this.readInstalledRecord(moduleId, version)
        const grant =
          this.findGrant(moduleId, version) ??
          ({
            moduleId,
            version,
            integrity: record.integrity,
            capabilities: {},
            grantedAt: record.installedAt,
            futureVersions: false,
          } satisfies ModuleGrant)
        modules.push(this.toInstalled(record, grant))
      }
    }

    modules.sort((a, b) => {
      if (a.manifest.id !== b.manifest.id) return a.manifest.id < b.manifest.id ? -1 : 1
      return compareVersions(a.manifest.version, b.manifest.version)
    })
    return modules
  }

  get(moduleId: string, version?: string): InstalledModule | undefined {
    const installed = this.list().filter((module) => module.manifest.id === moduleId)
    if (version !== undefined) {
      return installed.find((module) => module.manifest.version === version)
    }

    const activeVersion = this.state.active[moduleId]
    if (activeVersion !== undefined) {
      const active = installed.find((module) => module.manifest.version === activeVersion)
      if (active !== undefined) return active
    }

    let latest: InstalledModule | undefined
    for (const module of installed) {
      if (latest === undefined || newer(module.manifest.version, latest.manifest.version)) {
        latest = module
      }
    }
    return latest
  }

  propose(directory: string): ProposedModule {
    const source = resolve(directory)
    if (!existsSync(source) || !statSync(source).isDirectory()) {
      throw new ModuleStoreError('not-a-directory', `not a module directory: ${source}`)
    }

    const manifest = readManifestFromDirectory(source)
    if (!existsSync(resolve(source, manifest.entry))) {
      throw new ModuleStoreError(
        'entry-missing',
        `entry "${manifest.entry}" does not exist in ${source}`,
      )
    }

    // A source shipped without package.json still installs as ESM: the copy
    // gains one, and the source digest is computed as if it already had it so
    // both sides agree.
    const sourceAdditions = existsSync(join(source, 'package.json'))
      ? {}
      : { 'package.json': MODULE_PACKAGE_JSON }
    const sourceIntegrity = directoryIntegrity(source, manifest, sourceAdditions)
    mkdirSync(this.proposalsDir, { recursive: true })
    const target = join(this.proposalsDir, `${manifest.id}@${manifest.version}`)

    if (existsSync(target)) {
      // Heal proposals made before the ESM marker existed.
      ensureModuleType(target)
      const existingManifest = readManifestFromDirectory(target)
      const existingIntegrity = directoryIntegrity(target, existingManifest)
      if (existingIntegrity !== sourceIntegrity) {
        throw new ModuleStoreError(
          'integrity-conflict',
          `proposal ${manifest.id}@${manifest.version} already exists with a different integrity`,
        )
      }
      return {
        manifest: existingManifest,
        directory: target,
        integrity: existingIntegrity,
        proposedAt: statSync(target).mtimeMs,
      }
    }

    const temporary = join(this.proposalsDir, `.${manifest.id}@${manifest.version}.${randomUUID()}.tmp`)
    copyPayload(source, temporary)
    ensureModuleType(temporary)
    const copiedIntegrity = directoryIntegrity(temporary, manifest)
    if (copiedIntegrity !== sourceIntegrity) {
      rmSync(temporary, { recursive: true, force: true })
      throw new ModuleStoreError(
        'integrity-conflict',
        `copied proposal for ${manifest.id}@${manifest.version} does not match its source`,
      )
    }
    renameSync(temporary, target)

    this.auditLog.append({
      type: 'propose',
      moduleId: manifest.id,
      version: manifest.version,
      integrity: sourceIntegrity,
      detail: { directory: source },
    })

    return {
      manifest,
      directory: target,
      integrity: sourceIntegrity,
      proposedAt: Date.now(),
    }
  }

  proposals(): readonly ProposedModule[] {
    const proposed: ProposedModule[] = []

    for (const name of directories(this.proposalsDir)) {
      const separator = name.lastIndexOf('@')
      if (separator <= 0) continue

      const directory = join(this.proposalsDir, name)
      const manifest = readManifestFromDirectory(directory)
      proposed.push({
        manifest,
        directory,
        integrity: directoryIntegrity(directory, manifest),
        proposedAt: statSync(directory).mtimeMs,
      })
    }

    proposed.sort((a, b) => {
      if (a.manifest.id !== b.manifest.id) return a.manifest.id < b.manifest.id ? -1 : 1
      return compareVersions(a.manifest.version, b.manifest.version)
    })
    return proposed
  }

  approve(
    moduleId: string,
    version: string,
    options?: { futureVersions?: boolean },
  ): InstalledModule {
    const directory = join(this.proposalsDir, `${moduleId}@${version}`)
    if (!existsSync(directory)) {
      throw new ModuleStoreError(
        'not-proposed',
        `module ${moduleId}@${version} has not been proposed`,
      )
    }

    const manifest = readManifestFromDirectory(directory)
    if (manifest.id !== moduleId || manifest.version !== version) {
      throw new ModuleStoreError(
        'invalid-manifest',
        `proposal directory ${directory} contains ${manifest.id}@${manifest.version}`,
      )
    }

    const integrity = directoryIntegrity(directory, manifest)
    const existing = this.findGrant(moduleId, version)
    if (existing !== undefined && existing.integrity !== integrity) {
      throw new ModuleStoreError(
        'integrity-conflict',
        `grant for ${moduleId}@${version} covers a different integrity`,
      )
    }

    const futureVersions = options?.futureVersions ?? existing?.futureVersions ?? false
    const installed = this.install(moduleId, version, {
      capabilities: manifest.capabilities ?? {},
      futureVersions,
    })

    if (
      existing === undefined ||
      existing.futureVersions !== futureVersions ||
      canonicalJson(existing.capabilities) !== canonicalJson(manifest.capabilities ?? {})
    ) {
      this.auditLog.append({
        type: 'approve',
        moduleId,
        version,
        integrity,
        detail: { futureVersions },
      })
    }
    return installed
  }

  install(
    moduleId: string,
    version: string,
    grant: Omit<ModuleGrant, 'moduleId' | 'version' | 'integrity' | 'grantedAt'>,
  ): InstalledModule {
    const proposalDirectory = join(this.proposalsDir, `${moduleId}@${version}`)
    if (!existsSync(proposalDirectory)) {
      throw new ModuleStoreError(
        'not-proposed',
        `module ${moduleId}@${version} has not been proposed`,
      )
    }

    const manifest = readManifestFromDirectory(proposalDirectory)
    if (manifest.id !== moduleId || manifest.version !== version) {
      throw new ModuleStoreError(
        'invalid-manifest',
        `proposal directory contains ${manifest.id}@${manifest.version}, not ${moduleId}@${version}`,
      )
    }

    ensureModuleType(proposalDirectory)
    const integrity = directoryIntegrity(proposalDirectory, manifest)
    const existingGrant = this.findGrant(moduleId, version)
    if (existingGrant !== undefined && existingGrant.integrity !== integrity) {
      throw new ModuleStoreError(
        'integrity-conflict',
        `grant for ${moduleId}@${version} covers a different integrity`,
      )
    }

    const directory = this.installedDirectory(moduleId, version)
    if (existsSync(directory)) {
      const record = this.readInstalledRecord(moduleId, version)
      if (record.integrity !== integrity) {
        throw new ModuleStoreError(
          'integrity-conflict',
          `${moduleId}@${version} is installed with a different integrity`,
        )
      }
      const savedGrant = this.persistGrant(moduleId, version, integrity, grant)
      return this.toInstalled(record, savedGrant)
    }

    mkdirSync(join(this.modulesDir, moduleId), { recursive: true })
    const temporary = join(this.modulesDir, moduleId, `.${version}.${randomUUID()}.tmp`)
    copyPayload(proposalDirectory, temporary)
    ensureModuleType(temporary)

    const copiedIntegrity = directoryIntegrity(temporary, manifest)
    if (copiedIntegrity !== integrity) {
      rmSync(temporary, { recursive: true, force: true })
      throw new ModuleStoreError(
        'integrity-conflict',
        `copied install for ${moduleId}@${version} does not match the proposal`,
      )
    }

    const installedAt = Date.now()
    const record: InstalledRecord = { manifest, integrity, installedAt }
    writeFileSync(join(temporary, 'installed.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8')
    renameSync(temporary, directory)

    const savedGrant = this.persistGrant(moduleId, version, integrity, grant)
    this.auditLog.append({
      type: 'install',
      moduleId,
      version,
      integrity,
      detail: { directory },
    })
    return this.toInstalled(record, savedGrant)
  }

  activate(moduleId: string, version?: string): InstalledModule {
    const installed = this.list().filter((module) => module.manifest.id === moduleId)
    if (installed.length === 0) {
      throw new ModuleStoreError('not-installed', `module ${moduleId} is not installed`)
    }

    let target: InstalledModule | undefined
    if (version !== undefined) {
      target = installed.find((module) => module.manifest.version === version)
    } else {
      for (const module of installed) {
        if (target === undefined || newer(module.manifest.version, target.manifest.version)) {
          target = module
        }
      }
    }
    if (target === undefined) {
      throw new ModuleStoreError(
        'not-installed',
        `module ${moduleId}@${version ?? '(latest)'} is not installed`,
      )
    }

    const previous = this.state.active[moduleId]
    if (previous !== target.manifest.version) {
      this.state.active[moduleId] = target.manifest.version
      this.saveState()
      this.auditLog.append({
        type: 'activate',
        moduleId,
        version: target.manifest.version,
        integrity: target.integrity,
        detail: { previous: previous ?? null },
      })
    }

    return { ...target, active: true }
  }

  rollback(moduleId: string): InstalledModule | undefined {
    const activeVersion = this.state.active[moduleId]
    if (activeVersion === undefined) return undefined

    const installed = this.list().filter((module) => module.manifest.id === moduleId)
    let target: InstalledModule | undefined
    for (const module of installed) {
      if (compareVersions(module.manifest.version, activeVersion) >= 0) continue
      if (target === undefined || newer(module.manifest.version, target.manifest.version)) {
        target = module
      }
    }
    if (target === undefined) return undefined

    this.state.active[moduleId] = target.manifest.version
    this.saveState()
    this.auditLog.append({
      type: 'rollback',
      moduleId,
      version: target.manifest.version,
      integrity: target.integrity,
      detail: { previous: activeVersion },
    })
    return { ...target, active: true }
  }

  grants(): readonly ModuleGrant[] {
    return [...this.state.grants]
  }

  audit(): readonly AuditEntry[] {
    return this.auditLog.read()
  }

  recordDenied(moduleId: string, version: string, reason: string): void {
    this.auditLog.append({ type: 'deny', moduleId, version, detail: { reason } })
  }

  /** Extra audit hook for the host layer (T22); same chain, distinct type. */
  recordCapabilityDenied(moduleId: string, version: string, detail: Record<string, unknown>): void {
    this.auditLog.append({ type: 'capability.denied', moduleId, version, detail })
  }
}
