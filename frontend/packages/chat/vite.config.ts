import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// @ae/chat — the chat SPA. Separate build/deploy target from @ae/admin
// (packages/admin), but both run against the SAME Chime app instance +
// Cognito user pool via @ae/shared (see packages/shared). Single entry
// (index.html -> src/main.tsx); the chat bundle never pulls in admin code —
// see scripts/assert-no-admin-in-chat.mjs at the workspace root.
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
