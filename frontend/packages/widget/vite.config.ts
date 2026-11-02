import { resolve } from 'path'
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// @ae/widget - the embeddable assistant widget. Two outputs, both into dist/:
//   - index.html and its assets (this config): the document a host page frames. It is served from the
//     `<prefix>Widget` origin, whose `frame-ancestors` names the hosts the deployment declares.
//   - invite.html (this config too): the invitation landing page an invitation's link opens. A top-level
//     page on the same origin, served with its own headers (never framed, no referrer).
//   - embed.js (vite.embed.config.ts): the small loader a host page includes. It creates the frame,
//     sizes it, and relays a host's assertion into it. It bundles no framework.
// Published by `backend/scripts/deploy-frontend.mjs --widget`, never by cdk.
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
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        invite: resolve(__dirname, 'invite.html'),
      },
    },
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    root: '.',
  },
})
