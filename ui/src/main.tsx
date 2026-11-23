import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { LocaleProvider } from './locale'
import { PwaUpdateBanner } from './pwa/UpdateBanner'
import { registerPwa } from './pwa/register'
import { markFirstShell } from './pwa/telemetry'
import './styles.css'

const root = document.querySelector('#root')
if (!root) throw new Error('missing root')
createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <App />
      <PwaUpdateBanner />
    </LocaleProvider>
  </StrictMode>,
)
markFirstShell()
registerPwa()
