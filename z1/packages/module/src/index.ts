export const PACKAGE = '@z1/module'

export type {
  DeclaredPort,
  ModuleCapabilities,
  ModuleManifest,
  ModuleNodeDeclaration,
  ModuleServiceDeclaration,
  ModuleServiceKind,
  ModuleServiceMode,
} from './types.ts'
export type { ManifestIssue } from './manifest.ts'
export {
  ModuleManifestError,
  compareVersions,
  manifestDigest,
  parseManifest,
  serviceMode,
} from './manifest.ts'
export type {
  InstalledModule,
  ModuleGrant,
  ModuleStoreErrorCode,
  ProposedModule,
} from './store.ts'
export { MODULE_MANIFEST_FILES, ModuleStore, ModuleStoreError } from './store.ts'
export type { AuditAppend, AuditEntry } from './audit.ts'
export { AuditChainError, AuditLog, GENESIS_HASH, auditEntryHash } from './audit.ts'
export {
  checkFs,
  checkFsReal,
  checkLlm,
  checkNet,
  checkProcess,
  checkTool,
  matchPath,
  resolveCapabilityPath,
} from './capability.ts'
export type { CapabilityCheck } from './capability.ts'
export { directoryIntegrity, sha256Hex, walkIntegrityFiles } from './integrity.ts'
export type { IntegrityFile } from './integrity.ts'
