# Security

## Supported versions

`main` is the supported branch. Releases are cut from it; older commits are not
patched.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository
(**Security → Report a vulnerability**). Please do not open a public issue for a
suspected vulnerability. Include the affected commit, a minimal reproduction, and
what an attacker gains.

## Trust model

z1 executes code that the user explicitly approves, and it tries to make the
boundary legible rather than absolute.

- **Node modules** run in a child process under Node's permission model
  (`fs` read/write flags, no child processes by default). Every capability call
  (`ctx.fs`, `ctx.net`, `ctx.process`, `ctx.llm`, `ctx.tools`, approval) is
  brokered by the host, checked against the module grant, and audited.
- **Service modules** are worker-hosted by default. A service may declare
  `mode: "host"` only with `trusted: true`; host services run in-process and have
  the host's reach. Approving one is a statement that you trust its code.
- **Network is not a syscall boundary.** Node's permission model does not block
  direct sockets or `fetch` inside a worker. The supported path is `ctx.net`,
  which enforces the manifest's host allowlist. Untrusted modules still need an
  OS-level sandbox (container, netns, seccomp) that z1 does not provide.
- **Tools are not shipped here.** The SDK keeps the tools service contract and
  brokered capabilities; concrete tools live in a separate repository.
- **Secrets** are resolved by the host and are never passed into a worker. Keep
  provider keys in the environment or in a host-side credential reference.
- **Approvals** are per node (`auto`, `ask`, `deny`). A `deny` node cannot be
  satisfied by another node's cached output, and a rejected action is not retried
  through another tool.

## Hardening checklist

- Review the manifest capabilities shown by `z1 module approve` before granting.
- Prefer `mode: "worker"` services; use `host` only for code you wrote.
- Keep module capabilities narrow (`${moduleDir}`, workspace globs, explicit
  commands) instead of `/**` / `*`.
- Run untrusted modules behind an OS sandbox; see the caveat above.
- Treat tool output, repository files and web content as untrusted data; the
  system prompt tells the agent to do the same, but the runtime boundary is the
  one that counts.
