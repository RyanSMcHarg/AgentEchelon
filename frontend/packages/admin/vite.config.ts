import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { dirname, resolve } from 'path'
import { searchForWorkspaceRoot, type Plugin } from 'vite'

/**
 * Backend sources the console imports resolve to their TypeScript source.
 *
 * The backend names its modules by their `.js` specifier, or by none (`./model-strategy`), and compiles them
 * beside the source, so a relative `./x.js` or `./x` inside `backend/` is read as `./x.ts`, whether or not a
 * compiled copy sits next to it. The console bundles exactly the source the router runs.
 */
function backendTypeScriptSource(): Plugin {
  return {
    name: 'backend-typescript-source',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !source.startsWith('.')) return null
      if (!importer.replace(/\\/g, '/').includes('/backend/')) return null
      const base = source.endsWith('.js') ? source.slice(0, -3) : /\.[cm]?[jt]sx?$/.test(source) ? null : source
      if (base === null) return null
      const ts = resolve(dirname(importer), `${base}.ts`)
      return existsSync(ts) ? ts : null
    },
  }
}

/**
 * The commit this bundle was built from, stamped into the bundle itself.
 *
 * THE SAME FUNCTION THE CHAT CONFIG HAS CARRIED SINCE 2026-08-07, and the reason it exists applies
 * MORE here, not less. The chat stamp was added because a deployed bundle eight commits behind made a
 * spec fail in a way that looked like a product bug until somebody diffed the served JavaScript by
 * hand. This console is where the operator surfaces live - profiles, effectiveness, experiments,
 * conversations - so a console a commit behind shows an operator the wrong behaviour while the
 * backend answers correctly, which is the same failure against a harder-to-notice audience.
 *
 * Until this existed there was no way to ask the question at all: `deployed-build.spec.ts` covered
 * the chat bundle only, and the admin bundle carried no stamp to compare.
 *
 * Falls back to 'unknown' outside a git checkout, so a missing stamp degrades to "cannot check"
 * rather than failing the build.
 */
function builtFromCommit(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

// @ae/admin — the operator console. Separate build/deploy target from
// @ae/chat, but runs against the SAME Chime app instance + Cognito user
// pool via @ae/shared. Single entry (index.html -> src/main.tsx). Gates on
// the `admins` Cognito group at render time; the backend independently
// enforces requireAdmin on every admin API.
export default defineConfig({
  plugins: [backendTypeScriptSource(), react()],
  define: {
    global: 'globalThis',
    __BUILT_FROM_COMMIT__: JSON.stringify(builtFromCommit()),
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
  // The welcome editor previews an opening with the router's own pure renderer
  // (`backend/lambda/src/lib/welcome-orientation.ts` and the marker modules it reads), the message template
  // editor previews with the renderer every message is posted with (`message-template.ts`), and the route editor
  // applies the write path's image-route rules (`image-route.ts`, which reads `lib/config/model-catalog.ts`),
  // so the dev server serves those two directories beside the workspace. The production build bundles them like any module,
  // through `backendTypeScriptSource` above.
  server: {
    fs: {
      allow: [
        searchForWorkspaceRoot(process.cwd()),
        '../../../backend/lambda/src/lib',
        '../../../backend/lib/config',
      ],
    },
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
