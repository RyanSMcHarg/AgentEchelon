import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@ae/shared/styles/index.css'
import '@ae/shared/i18n'
import { capturePendingInvitation, capturePendingUpgrade, requestPendingBindSecret } from '@ae/shared'
import App from './App.tsx'

// A sign-in invitation's landing page sends its holder here with the token in the fragment. It leaves the
// address bar before anything renders, and rides on the first sign-in (`pendingInvitation.ts`, M-10).
capturePendingInvitation()
// The widget sends a visitor here to keep the visit, with it in the fragment (`pendingUpgrade.ts`): path A's
// hand-off nonce, whose secret the widget that opened this tab answers with, rides on the first sign-in;
// path B's claim is redeemed once signed in.
capturePendingUpgrade()
void requestPendingBindSecret()

/**
 * The commit this bundle was built from, published on `window` so the e2e suite can tell whether the
 * DEPLOYED app is the one the tests were written against.
 *
 * Stamped by vite (`__BUILT_FROM_COMMIT__`). It exists because a bundle eight commits behind source
 * once failed a spec that matched source perfectly, and the only way to establish that was diffing
 * class names out of the served JavaScript by hand.
 */
declare const __BUILT_FROM_COMMIT__: string
;(window as unknown as { __BUILT_FROM_COMMIT__?: string }).__BUILT_FROM_COMMIT__ =
  typeof __BUILT_FROM_COMMIT__ === 'string' ? __BUILT_FROM_COMMIT__ : 'unknown'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
