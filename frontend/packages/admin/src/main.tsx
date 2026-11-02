import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@ae/shared/styles/index.css'
import './admin-theme.css'
import '@ae/shared/i18n'
import AdminApp from './AdminApp.tsx'

/**
 * The commit this bundle was built from, published on `window` so the e2e suite can tell whether the
 * DEPLOYED console is the one the tests were written against.
 *
 * THE DEFINE ALONE DOES NOTHING, which is the trap this assignment exists to avoid. Vite's `define`
 * substitutes occurrences in SOURCE; adding it to `vite.config.ts` with nothing referencing the
 * symbol emits no stamp, and the build output is byte-identical - the published asset keeps its old
 * content hash and the guard still reports "no build stamp". Measured exactly that way on
 * 2026-10-02: the config was added, the console was republished, and nothing changed.
 *
 * The console matters more than the chat app here rather than less: this is where the operator
 * surfaces live, so a console a commit behind shows an operator the wrong behaviour while the backend
 * answers correctly.
 */
declare const __BUILT_FROM_COMMIT__: string
;(window as unknown as { __BUILT_FROM_COMMIT__?: string }).__BUILT_FROM_COMMIT__ =
  typeof __BUILT_FROM_COMMIT__ === 'string' ? __BUILT_FROM_COMMIT__ : 'unknown'

// Standalone admin console entry (separate app from the chat SPA — see
// DESIGN-SEPARATE-ADMIN-APP.md). Deliberately mounts ONLY AdminApp: no chat
// messaging providers (Chime/conversation/messaging), no chat routes. The
// admin surface reads its own token from AuthProvider and calls the admin APIs
// directly, so the chat client stack is not imported here.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
)
