/**
 * A module manifest is the reviewable contract between a third-party module
 * and the host. It is pure data: no code is imported while parsing it.
 */
export interface ModuleManifest {
  schemaVersion: 1
  /** Reverse-DNS identifier, e.g. `com.example.echo`. */
  id: string
  /** Strict semver `x.y.z` with an optional `-prerelease` suffix. */
  version: string
  title: string
  description?: string
  author?: string
  /** Required: modules must always state a license. */
  license: string
  /** Host range this module was built against. Not parsed in M4. */
  engines: { z1: string }
  /** Relative POSIX path to the ESM entry point (`.js` / `.mjs`). */
  entry: string
  nodes: ModuleNodeDeclaration[]
  /**
   * Ambient services this module provides. v1 only accepts trusted in-process
   * modules; see {@link ModuleServiceDeclaration}.
   */
  services?: ModuleServiceDeclaration[]
  capabilities?: ModuleCapabilities
  limits?: { timeoutMs?: number; memoryMb?: number }
}

/** The runtime service slots a module may replace. */
export type ModuleServiceKind = 'llm' | 'tools' | 'fs' | 'artifacts' | 'memory'

/**
 * A service a module provides to the host process.
 *
 * v1 runs service modules in-process, so `trusted` must be literally `true`:
 * the grant is the security boundary, not a worker sandbox.
 */
export interface ModuleServiceDeclaration {
  /** Unique within this module, e.g. `llm` or `my-tools`. */
  id: string
  kind: ModuleServiceKind
  trusted: true
}

export type DeclaredPort =
  | {
      kind: 'data'
      id: string
      title?: string
      description?: string
      /** JSON Schema of the wire value. */
      schema?: Record<string, unknown>
      required?: boolean
      mode?: 'value' | 'stream'
    }
  | { kind: 'flow'; id: string; title?: string; description?: string }

export interface ModuleNodeDeclaration {
  /** Dotted, lower-kebab segments, e.g. `com.example.echo.run`. */
  id: string
  version: string
  title: string
  category: string
  inputs: DeclaredPort[]
  outputs: DeclaredPort[]
  configSchema?: Record<string, unknown>
  capabilities?: ModuleCapabilities
}

export interface ModuleCapabilities {
  fs?: { read?: string[]; write?: string[] }
  net?: { hosts?: string[] }
  process?: { spawn?: string[] }
  spend?: { currency: string; perCall?: number; perRun?: number }
  secrets?: string[]
}
