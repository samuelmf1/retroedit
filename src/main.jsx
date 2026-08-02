import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AppErrorBoundary from './components/AppErrorBoundary.jsx'
import TooltipProvider from './components/TooltipProvider.jsx'

// A page left open across a deployment can still reference an older lazy chunk.
// Refresh once so it picks up the current HTML/asset manifest instead of showing
// a fatal module-load error. The timestamp guard prevents a reload loop if the
// failure is unrelated to a deployment.
window.addEventListener('vite:preloadError', (event) => {
  event.preventDefault()
  const key = 'retroedit:stale-chunk-reload'
  const previous = Number(sessionStorage.getItem(key) || 0)
  if (Date.now() - previous > 15_000) {
    sessionStorage.setItem(key, String(Date.now()))
    window.location.reload()
  }
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <TooltipProvider>
      <AppErrorBoundary>
        <App />
      </AppErrorBoundary>
    </TooltipProvider>
  </StrictMode>,
)
