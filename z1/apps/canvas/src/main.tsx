import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import { applyInitialConnection, useCanvas } from './store.ts'
import '@xyflow/react/dist/style.css'
import './styles.css'

// A link printed by the CLI carries `?url=...&token=...`; it seeds the toolbar
// and connects once so the page is usable without any clicks.
const autoConnect = applyInitialConnection()

const root = document.getElementById('root')
if (root === null) throw new Error('z1 canvas: missing #root')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

if (autoConnect) void useCanvas.getState().connectServer()
