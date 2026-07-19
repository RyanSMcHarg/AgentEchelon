import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './i18n'
import AdminApp from './AdminApp.tsx'

// Standalone admin console entry (separate app from the chat SPA — see
// SPEC-SEPARATE-ADMIN-APP.md). Deliberately mounts ONLY AdminApp: no chat
// messaging providers (Chime/conversation/messaging), no chat routes. The
// admin surface reads its own token from AuthProvider and calls the admin APIs
// directly, so the chat client stack is not imported here.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AdminApp />
  </StrictMode>,
)
