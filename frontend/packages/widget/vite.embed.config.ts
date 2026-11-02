import { defineConfig } from 'vite'
import { resolve } from 'path'

// The host-page loader, `dist/embed.js`: one IIFE exposing `window.AEWidget`, no framework, so a host
// page that is not a React app (or a Salesforce Lightning component) loads it with one script tag.
// Built after the frame document, into the same dist/ (emptyOutDir off, so it keeps index.html).
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/embed/embed.ts'),
      name: 'AEWidget',
      formats: ['iife'],
      fileName: () => 'embed.js',
    },
  },
})
