import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'

// The z1 workspace has its own tsconfig root, so path aliases must come from
// tsconfig.base.json rather than the upstream repository config.
export default defineConfig({
  plugins: [tsconfigPaths({ projects: ['./tsconfig.base.json'] })],
  test: {
    include: ['packages/*/tests/**/*.spec.ts', 'apps/*/tests/**/*.spec.ts'],
    pool: 'forks',
  },
})
