import { createHash } from 'node:crypto'
import { z } from 'zod'
import { canonicalJson } from './canonical.ts'
import type {
  DeclaredPort,
  ModuleCapabilities,
  ModuleManifest,
  ModuleNodeDeclaration,
  ModuleServiceDeclaration,
  ModuleServiceMode,
} from './types.ts'

/**
 * Reverse-DNS module id from the manifest contract. Kept identical to SPEC so
 * ids in graph documents and module declarations agree.
 */
const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/
/** Strict semver: exactly three numeric components plus optional prerelease. */
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/
/** Qualified node id: at least two dotted lower-kebab segments. */
const NODE_ID_PATTERN =
  /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)+$/
const PORT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/
/** Service ids stay lower-kebab, like one segment of a node id. */
const SERVICE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export interface ManifestIssue {
  path: string
  message: string
}

/** Raised when a manifest is structurally or semantically invalid. */
export class ModuleManifestError extends Error {
  readonly issues: readonly ManifestIssue[]

  constructor(issues: readonly ManifestIssue[]) {
    const first = issues[0]
    super(
      first === undefined
        ? 'invalid module manifest'
        : `invalid module manifest: ${first.path || '(root)'}: ${first.message}`,
    )
    this.name = 'ModuleManifestError'
    this.issues = issues
  }
}

function toIssues(error: z.ZodError): ManifestIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.'),
    message: issue.message,
  }))
}

function nonEmpty(message: string) {
  return z.string().trim().min(1, message)
}

const semverSchema = z.string().regex(SEMVER_PATTERN, 'must be strict semver x.y.z[-prerelease]')
const stringListSchema = z.array(nonEmpty('must be a non-empty string'))

const dataPortSchema = z.strictObject({
  kind: z.literal('data'),
  id: z.string().regex(PORT_ID_PATTERN, 'must be a non-empty port id without whitespace'),
  title: nonEmpty('must not be empty').optional(),
  description: z.string().optional(),
  schema: z.record(z.string(), z.unknown()).optional(),
  required: z.boolean().optional(),
  mode: z.enum(['value', 'stream']).optional(),
})

const flowPortSchema = z.strictObject({
  kind: z.literal('flow'),
  id: z.string().regex(PORT_ID_PATTERN, 'must be a non-empty port id without whitespace'),
  title: nonEmpty('must not be empty').optional(),
  description: z.string().optional(),
})

const declaredPortSchema = z.discriminatedUnion('kind', [dataPortSchema, flowPortSchema])

const fsCapabilitySchema = z.strictObject({
  read: stringListSchema.optional(),
  write: stringListSchema.optional(),
})
const netCapabilitySchema = z.strictObject({ hosts: stringListSchema.optional() })
const processCapabilitySchema = z.strictObject({ spawn: stringListSchema.optional() })
const spendCapabilitySchema = z.strictObject({
  currency: nonEmpty('must not be empty'),
  perCall: z.number().finite().nonnegative().optional(),
  perRun: z.number().finite().nonnegative().optional(),
})
// `true` is the "any provider / any tool" grant; an object lists the allowed
// ones. A bare `{}` is therefore a grant of nothing, not a grant of everything.
const llmCapabilitySchema = z.union([
  z.literal(true),
  z.strictObject({ providers: stringListSchema.optional() }),
])
const toolsCapabilitySchema = z.union([
  z.literal(true),
  z.strictObject({ names: stringListSchema.optional() }),
])
const capabilitiesSchema = z.strictObject({
  fs: fsCapabilitySchema.optional(),
  net: netCapabilitySchema.optional(),
  process: processCapabilitySchema.optional(),
  spend: spendCapabilitySchema.optional(),
  secrets: stringListSchema.optional(),
  llm: llmCapabilitySchema.optional(),
  tools: toolsCapabilitySchema.optional(),
})

const limitsSchema = z.strictObject({
  timeoutMs: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
})

type PortData = z.infer<typeof declaredPortSchema>
type CapabilitiesData = z.infer<typeof capabilitiesSchema>
type LimitsData = z.infer<typeof limitsSchema>

const serviceDeclarationSchema = z
  .strictObject({
    id: z.string().regex(SERVICE_ID_PATTERN, 'must be a lower-kebab service id'),
    kind: z.enum(['llm', 'tools', 'fs', 'artifacts', 'memory']),
    mode: z.enum(['worker', 'host']).optional(),
    // Kept optional: a legacy declaration is `trusted: true` with no mode, and
    // the default security posture (no mode, no trust) is a worker.
    trusted: z.boolean().optional(),
  })
  .superRefine((service, ctx) => {
    const mode = service.mode ?? (service.trusted === true ? 'host' : 'worker')
    if (mode === 'host' && service.trusted !== true) {
      ctx.addIssue({
        code: 'custom',
        path: ['mode'],
        message: 'host services run in the host process; add "trusted": true',
      })
    }
    if (mode === 'worker' && service.trusted === true) {
      ctx.addIssue({
        code: 'custom',
        path: ['trusted'],
        message: 'worker services run in the sandbox; remove "trusted"',
      })
    }
  })

type ServiceData = z.infer<typeof serviceDeclarationSchema>

const nodeDeclarationSchema = z
  .strictObject({
    id: z.string().regex(NODE_ID_PATTERN, 'must be dotted lower-kebab segments'),
    version: semverSchema,
    title: nonEmpty('must not be empty'),
    category: nonEmpty('must not be empty'),
    inputs: z.array(declaredPortSchema),
    outputs: z.array(declaredPortSchema),
    configSchema: z.record(z.string(), z.unknown()).optional(),
    capabilities: capabilitiesSchema.optional(),
  })
  .superRefine((node, ctx) => {
    for (const direction of ['inputs', 'outputs'] as const) {
      const seen = new Set<string>()
      node[direction].forEach((port, index) => {
        if (seen.has(port.id)) {
          ctx.addIssue({
            code: 'custom',
            path: [direction, index, 'id'],
            message: `duplicate ${direction} port id "${port.id}"`,
          })
        }
        seen.add(port.id)
      })
    }
  })

type NodeData = z.infer<typeof nodeDeclarationSchema>

function entryProblem(entry: string): string | undefined {
  if (entry.length === 0) return 'must not be empty'
  if (entry.startsWith('/')) return 'must be a relative path'
  if (/^[A-Za-z]:/.test(entry)) return 'must be a relative POSIX path'
  if (entry.includes('\\')) return 'must use POSIX separators'
  const segments = entry.split('/')
  if (segments.some((segment) => segment === '')) return 'must not contain empty segments'
  if (segments.some((segment) => segment === '..')) return 'must not escape the module directory'
  if (!/\.(?:js|mjs)$/.test(entry)) return 'must end in .js or .mjs'
  return undefined
}

const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: z.string().regex(MODULE_ID_PATTERN, 'must be a reverse-DNS module id'),
    version: semverSchema,
    title: nonEmpty('must not be empty'),
    description: z.string().optional(),
    author: z.string().optional(),
    license: nonEmpty('must not be empty'),
    engines: z.strictObject({ z1: nonEmpty('must not be empty') }),
    entry: z.string(),
    nodes: z.array(nodeDeclarationSchema).default([]),
    services: z.array(serviceDeclarationSchema).optional(),
    capabilities: capabilitiesSchema.optional(),
    limits: limitsSchema.optional(),
  })
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>()
    manifest.nodes.forEach((node, index) => {
      if (seen.has(node.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'id'],
          message: `duplicate node id "${node.id}"`,
        })
      }
      seen.add(node.id)
    })

    const seenServices = new Set<string>()
    ;(manifest.services ?? []).forEach((service, index) => {
      // Duplicates *within* a module are meaningless: one id is one factory.
      // The same kind in two different modules is fine and resolved by version.
      if (seenServices.has(service.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['services', index, 'id'],
          message: `duplicate service id "${service.id}"`,
        })
      }
      seenServices.add(service.id)
    })

    const problem = entryProblem(manifest.entry)
    if (problem !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['entry'], message: problem })
    }
  })

function toPort(port: PortData): DeclaredPort {
  if (port.kind === 'data') {
    const result: Extract<DeclaredPort, { kind: 'data' }> = { kind: 'data', id: port.id }
    if (port.title !== undefined) result.title = port.title
    if (port.description !== undefined) result.description = port.description
    if (port.schema !== undefined) result.schema = port.schema
    if (port.required !== undefined) result.required = port.required
    if (port.mode !== undefined) result.mode = port.mode
    return result
  }

  const result: Extract<DeclaredPort, { kind: 'flow' }> = { kind: 'flow', id: port.id }
  if (port.title !== undefined) result.title = port.title
  if (port.description !== undefined) result.description = port.description
  return result
}

function toCapabilities(data: CapabilitiesData): ModuleCapabilities {
  const result: ModuleCapabilities = {}

  if (data.fs !== undefined) {
    const fs: NonNullable<ModuleCapabilities['fs']> = {}
    if (data.fs.read !== undefined) fs.read = [...data.fs.read]
    if (data.fs.write !== undefined) fs.write = [...data.fs.write]
    result.fs = fs
  }
  if (data.net !== undefined) {
    const net: NonNullable<ModuleCapabilities['net']> = {}
    if (data.net.hosts !== undefined) net.hosts = [...data.net.hosts]
    result.net = net
  }
  if (data.process !== undefined) {
    const process: NonNullable<ModuleCapabilities['process']> = {}
    if (data.process.spawn !== undefined) process.spawn = [...data.process.spawn]
    result.process = process
  }
  if (data.spend !== undefined) {
    const spend: NonNullable<ModuleCapabilities['spend']> = { currency: data.spend.currency }
    if (data.spend.perCall !== undefined) spend.perCall = data.spend.perCall
    if (data.spend.perRun !== undefined) spend.perRun = data.spend.perRun
    result.spend = spend
  }
  if (data.secrets !== undefined) result.secrets = [...data.secrets]
  if (data.llm !== undefined) {
    result.llm =
      data.llm === true
        ? true
        : data.llm.providers === undefined
          ? {}
          : { providers: [...data.llm.providers] }
  }
  if (data.tools !== undefined) {
    result.tools =
      data.tools === true
        ? true
        : data.tools.names === undefined
          ? {}
          : { names: [...data.tools.names] }
  }
  return result
}

function toLimits(data: LimitsData): NonNullable<ModuleManifest['limits']> {
  const result: NonNullable<ModuleManifest['limits']> = {}
  if (data.timeoutMs !== undefined) result.timeoutMs = data.timeoutMs
  if (data.memoryMb !== undefined) result.memoryMb = data.memoryMb
  return result
}

function toService(data: ServiceData): ModuleServiceDeclaration {
  // Persist the declaration as written: grants and the audit log are the
  // reviewable record, and a legacy `trusted: true` must not be rewritten.
  const result: ModuleServiceDeclaration = { id: data.id, kind: data.kind }
  if (data.mode !== undefined) result.mode = data.mode
  if (data.trusted !== undefined) result.trusted = data.trusted
  return result
}

/**
 * Where a declared service actually runs. `trusted: true` without an explicit
 * mode is the pre-mode spelling of a host service; everything else defaults to
 * the sandbox.
 */
export function serviceMode(declaration: ModuleServiceDeclaration): ModuleServiceMode {
  return declaration.mode ?? (declaration.trusted === true ? 'host' : 'worker')
}

function toNode(data: NodeData): ModuleNodeDeclaration {
  const result: ModuleNodeDeclaration = {
    id: data.id,
    version: data.version,
    title: data.title,
    category: data.category,
    inputs: data.inputs.map((port) => toPort(port)),
    outputs: data.outputs.map((port) => toPort(port)),
  }
  if (data.configSchema !== undefined) result.configSchema = data.configSchema
  if (data.capabilities !== undefined) result.capabilities = toCapabilities(data.capabilities)
  return result
}

/** Validate an unknown value and return a normalised manifest. */
export function parseManifest(input: unknown): ModuleManifest {
  const parsed = manifestSchema.safeParse(input)
  if (!parsed.success) {
    throw new ModuleManifestError(toIssues(parsed.error))
  }

  const data = parsed.data
  const result: ModuleManifest = {
    schemaVersion: 1,
    id: data.id,
    version: data.version,
    title: data.title,
    license: data.license,
    engines: { z1: data.engines.z1 },
    entry: data.entry,
    nodes: data.nodes.map((node) => toNode(node)),
  }
  if (data.description !== undefined) result.description = data.description
  if (data.author !== undefined) result.author = data.author
  if (data.services !== undefined) result.services = data.services.map(toService)
  if (data.capabilities !== undefined) result.capabilities = toCapabilities(data.capabilities)
  if (data.limits !== undefined) result.limits = toLimits(data.limits)
  return result
}

/** SHA-256 (hex) over the canonical JSON of the manifest. */
export function manifestDigest(manifest: ModuleManifest): string {
  return createHash('sha256').update(canonicalJson(manifest), 'utf8').digest('hex')
}

interface ParsedVersion {
  core: [number, number, number]
  prerelease: string[] | null
}

function parseVersion(version: string): ParsedVersion {
  const match = SEMVER_PATTERN.exec(version)
  if (match === null) {
    throw new TypeError(`not a valid semver version: "${version}"`)
  }
  const [, major, minor, patch, prerelease] = match
  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease === undefined ? null : prerelease.split('.'),
  }
}

function comparePrerelease(a: string[] | null, b: string[] | null): number {
  // A release outranks every prerelease of the same core version.
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1

  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const left = a[index]
    const right = b[index]
    if (left === undefined) return -1
    if (right === undefined) return 1
    if (left === right) continue

    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      return Number(left) < Number(right) ? -1 : 1
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    return left < right ? -1 : 1
  }
  return 0
}

/** Semver precedence; returns -1, 0 or 1. Invalid versions throw. */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)
  const right = parseVersion(b)

  for (let index = 0; index < 3; index += 1) {
    const l = left.core[index]
    const r = right.core[index]
    if (l !== undefined && r !== undefined && l !== r) return l < r ? -1 : 1
  }
  return comparePrerelease(left.prerelease, right.prerelease)
}
