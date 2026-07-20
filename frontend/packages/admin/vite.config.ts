import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// @ae/admin — the operator console. Separate build/deploy target from
// @ae/chat, but runs against the SAME Chime app instance + Cognito user
// pool via @ae/shared. Single entry (index.html -> src/main.tsx). Gates on
// the `admins` Cognito group at render time; the backend independently
// enforces requireAdmin on every admin API.
export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  build: {
    outDir: 'dist',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    root: '.',
  },
})
