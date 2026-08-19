import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'

/**
 * The commit this bundle was built from, stamped into the bundle itself.
 *
 * The e2e suite runs against the DEPLOYED app, and nothing could tell whether that app matched the
 * source the tests were written against. On 2026-08-07 it did not: the deployed chat bundle predated
 * a commit that had renamed a header control, so a spec updated to match source failed against a UI
 * eight commits behind - and the failure looked like a product bug for as long as it took to diff the
 * bundle by hand. `e2e/deployed-build.spec.ts` now reads this and says so up front.
 *
 * Falls back to 'unknown' outside a git checkout (a published tarball, a CI image without .git), so a
 * missing stamp degrades to "cannot check" rather than failing the build.
 */
function builtFromCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// @ae/chat — the chat SPA. Separate build/deploy target from @ae/admin
// (packages/admin), but both run against the SAME Chime app instance +
// Cognito user pool via @ae/shared (see packages/shared). Single entry
// (index.html -> src/main.tsx); the chat bundle never pulls in admin code —
// see scripts/assert-no-admin-in-chat.mjs at the workspace root.
export default defineConfig({
  plugins: [react()],
  define: {
    global: 'globalThis',
    __BUILT_FROM_COMMIT__: JSON.stringify(builtFromCommit()),
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
