import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@ae/shared/styles/index.css'
import '@ae/shared/i18n'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
