import React from 'react'
import ReactDOM from 'react-dom/client'
import { HostManager } from './hosts/HostManager'
import './styles.css'
import { registerServiceWorker } from './sw-register'

// Anti-FOUC theme bootstrap (LiX pattern): restore last picked theme before React paints.
try {
  const raw = localStorage.getItem('lix-web-ui')
  const theme = raw ? (JSON.parse(raw).state ?? {}).theme : null
  const isDark = theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  if (isDark) document.documentElement.classList.add('dark')
} catch {
  /* first run */
}

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <HostManager />
  </React.StrictMode>,
)

registerServiceWorker()
