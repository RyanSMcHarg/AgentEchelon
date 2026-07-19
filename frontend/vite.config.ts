import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

// Two build targets from one source tree (SPEC-SEPARATE-ADMIN-APP.md):
//   vite build               -> chat SPA  (index.html -> dist/,       loads .env[.production])
//   vite build --mode admin  -> admin app (admin.html -> dist-admin/, loads .env + .env.admin)
// Each target builds ONLY its own entry, so the chat bundle tree-shakes out all
// components/admin/* code and never carries the admin-only VITE_* endpoint URLs
// (those live in .env.admin, which the chat/production build does not load).
// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const isAdmin = mode === 'admin'
  return {
    plugins: [react()],
    define: {
      global: 'globalThis',
    },
    build: {
      outDir: isAdmin ? 'dist-admin' : 'dist',
      rollupOptions: {
        input: isAdmin ? resolve(root, 'admin.html') : resolve(root, 'index.html'),
      },
    },
    test: {
      globals: true,
      environment: 'jsdom',
      setupFiles: './src/test/setup.ts',
      root: '.',
    },
  }
})
