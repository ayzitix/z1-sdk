import { ReactFlowProvider } from '@xyflow/react'
import type { ReactElement } from 'react'

import { ApprovalDialog } from './components/ApprovalDialog.tsx'
import { GraphCanvas } from './components/GraphCanvas.tsx'
import { Inspector } from './components/Inspector.tsx'
import { ModulesPanel } from './components/ModulesPanel.tsx'
import { OutputsPanel } from './components/OutputsPanel.tsx'
import { Palette } from './components/Palette.tsx'
import { RunsPanel } from './components/RunsPanel.tsx'
import { Toolbar } from './components/Toolbar.tsx'

export function App(): ReactElement {
  return (
    <div className="app">
      <Toolbar />
      <main className="workspace">
        <Palette />
        <section className="canvas-area">
          <ReactFlowProvider>
            <GraphCanvas />
          </ReactFlowProvider>
        </section>
        <aside className="side">
          <Inspector />
          <OutputsPanel />
        </aside>
      </main>
      <ModulesPanel />
      <RunsPanel />
      <ApprovalDialog />
    </div>
  )
}
