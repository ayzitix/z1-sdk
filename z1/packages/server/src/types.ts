/**
 * Public surface of the local `z1` server.
 *
 * @module @z1/server/types
 */

export interface ServerOptions {
  /** SQLite journal shared by every run this server owns. Default `.z1/runs.db`. */
  dbPath?: string
  /** Default `127.0.0.1`: the server is local-only unless asked otherwise. */
  host?: string
  /** Default `0`: the OS picks a free port, which `Z1Server.port` reports. */
  port?: number
  /** Default: 32 random hex characters generated per start. */
  token?: string
  /** Route registered providers' model calls to the real API; mock otherwise. */
  live?: boolean
  /** Credential source for `live`; default `process.env`. */
  env?: NodeJS.ProcessEnv
  /** How long `approval/request` may stay unanswered; default 300_000. */
  approvalTimeoutMs?: number
  /**
   * Module store root (proposals, installed versions, audit). Default
   * `Z1_MODULES_DIR` or `~/.z1/modules`.
   */
  modulesPath?: string
  /**
   * Graph library root, one JSON file per saved graph. Default `Z1_GRAPHS_DIR`
   * or `<cwd>/.z1/graphs`.
   */
  graphsPath?: string
  /**
   * Built canvas directory served on the same port as `/ws` (`GET /`, assets,
   * SPA fallback). Omitted means the HTTP port answers the protocol hint only.
   */
  staticDir?: string
}

export interface Z1Server {
  /** Origin without the socket path, e.g. `ws://127.0.0.1:43219`. */
  readonly url: string
  readonly token: string
  readonly port: number
  /** Idempotent: abort runs, drop sockets, close the journal. */
  close(): Promise<void>
}
