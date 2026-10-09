import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './app/App'
import { initializePreferences } from './app/preferencesStore'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Root element #root is missing from index.html')
}

// Apply stored preferences (the `.dark` class on <html>, calculator curve
// display defaults) synchronously before the first render, so the app
// paints in the chosen theme instead of flashing the wrong one.
initializePreferences()

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
