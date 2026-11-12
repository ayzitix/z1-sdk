import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tsconfigPaths from 'vite-tsconfig-paths'

// The z1 workspace has its own tsconfig root, so aliases must come from
// tsconfig.base.json rather than the upstream repository config.
export default defineConfig({
  plugins: [react(), tsconfigPaths({ projects: ['../../tsconfig.base.json'] })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  preview: {
    port: 5173,
  },
})
