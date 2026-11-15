/**
 * The environment a module worker inherits, as an explicit allowlist.
 *
 * Module code runs in a child process, and `process.env` is the cheapest way
 * for it to read a value it was never granted: enabled capability checks cover
 * fs/net/llm, not the environment. Handing the child all of `process.env` would
 * therefore leak every secret of the host process (provider keys, cloud
 * credentials, tokens of unrelated tools) to any installed module. Only the
 * categories below are passed instead:
 *
 * - process basics: `PATH` (needed to spawn anything inside the module),
 *   `TZ`, `TMPDIR`/`TMP`/`TEMP`, `LANG` and every `LC_*` locale variable;
 * - z1 settings the web/agent modules read: `Z1_SEARX_URL`, `Z1_SEARX_STATE`,
 *   `Z1_WEB_TIMEOUT_MS`, `Z1_WEB_AUTOSTART`, `Z1_GITHUB_TOKEN`, `Z1_STACK_KEY`;
 * - proxies, in both spellings, because request libraries normalise
 *   differently: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and their lowercase
 *   forms.
 *
 * Everything else — `RIVER_API_KEY`, `AWS_SECRET_ACCESS_KEY`, arbitrary
 * `Z1_*` — stays in the host process. A module that needs another variable
 * must have it added here explicitly (and to the docs), which is the point of
 * the allowlist: secrets are opt-in, never ambient.
 *
 * `Z1_SEARX_STATE` is a **snapshot taken at worker spawn**: the CLI installs
 * and starts SearXNG asynchronously, and a child spawned before that finishes
 * keeps the value it saw. Modules must still probe `Z1_SEARX_URL` (or the
 * backend) for live state; the variable only separates "starting" from "down".
 */
const WORKER_ENV_KEYS: readonly string[] = [
  // process basics
  'PATH',
  'TZ',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  // z1 web/agent settings
  'Z1_SEARX_URL',
  'Z1_SEARX_STATE',
  'Z1_WEB_TIMEOUT_MS',
  'Z1_WEB_AUTOSTART',
  'Z1_GITHUB_TOKEN',
  'Z1_STACK_KEY',
  // proxies (both spellings)
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
]

/** `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, … — locale is not a secret. */
const LC_ENTRY = /^LC_[A-Z]+$/

/**
 * Filter `source` down to the worker allowlist. Pure: it reads no globals of
 * its own when a source is supplied, and never mutates the input.
 *
 * `PATH` is always present (empty when the source has none) so `spawn` inside
 * the worker can still resolve an executable.
 */
export function workerEnvironment(
  source: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (!WORKER_ENV_KEYS.includes(key) && !LC_ENTRY.test(key)) continue
    env[key] = value
  }
  env['PATH'] = env['PATH'] ?? ''
  return env
}
