import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@ae/shared/styles/index.css'
import '@ae/shared/i18n'
import App from './App.tsx'

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
