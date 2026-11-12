# NOTICE

z1 sdk is derived from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
(`deepseek-ai/deepseek-harness`, MIT), taken at commit
`e8f7b93a34` (0.2.2-rc.2). The upstream copyright notice is preserved in
[LICENSE](LICENSE), and third-party components are listed in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## What this fork changes

The engine is kept as it is; product surfaces that the SDK does not need are
removed.

**Removed**

- `docs/` — the upstream documentation site content
- `website/` — the marketing and docs site
- `benchmarks/`
- `.agents/`, `.claude/` — internal working notes
- `apps/plugin-market-generator/`
- Documentation-site scripts (`scripts/project-doc-site.ts`,
  `scripts/stage-dsh-docs.ts`, `scripts/verify-doc-*.ts`,
  `scripts/gen-doc-graphs.ts`, `scripts/doc-sync.ts`) and their npm scripts
- Upstream branding, safety and translated README files

**Kept unchanged**

- Every runtime package, including `packages/client` (React UI packages) — they
  are the base for the node canvas
- `apps/web`, `apps/desktop`, `apps/cli`
- `packages/experimental` — upstream optional capabilities; they are not part of
  the SDK composition but their packages are still referenced by bundles

## What is still upstream

Package names (`@deepseek-ai/*`), the Cordis runtime and the plugin API are
unchanged. Renaming the scope and replacing the plugin API with the z1 module
contract is planned work, not done work.
