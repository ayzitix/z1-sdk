import type { GraphDocument } from '@z1/graph'
import { useRef, useState, type ReactElement } from 'react'

import { fromFlow } from '../graph.ts'
import { useCanvas } from '../store.ts'

/** Server connection, graph transport and run controls. */
export function Toolbar(): ReactElement {
  const url = useCanvas((state) => state.url)
  const token = useCanvas((state) => state.token)
  const connection = useCanvas((state) => state.connection)
  const connectionError = useCanvas((state) => state.connectionError)
  const title = useCanvas((state) => state.title)
  const nodes = useCanvas((state) => state.nodes)
  const edges = useCanvas((state) => state.edges)
  const runStatus = useCanvas((state) => state.runStatus)
  const setUrl = useCanvas((state) => state.setUrl)
  const setToken = useCanvas((state) => state.setToken)
  const setTitle = useCanvas((state) => state.setTitle)
  const connectServer = useCanvas((state) => state.connectServer)
  const disconnect = useCanvas((state) => state.disconnect)
  const run = useCanvas((state) => state.run)
  const cancel = useCanvas((state) => state.cancel)
  const loadGraph = useCanvas((state) => state.loadGraph)
  const runInput = useCanvas((state) => state.runInput)
  const setRunInput = useCanvas((state) => state.setRunInput)
  const [openError, setOpenError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const save = (): void => {
    const blob = new Blob([JSON.stringify(fromFlow(nodes, edges, title), null, 2)], {
      type: 'application/json',
    })
    const href = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    const name = (title.length > 0 ? title : 'graph').replace(/[^\w.-]+/g, '-')
    anchor.href = href
    anchor.download = `${name}.json`
    anchor.click()
    URL.revokeObjectURL(href)
  }

  const open = async (file: File): Promise<void> => {
    try {
      const text = await file.text()
      const parsed: unknown = JSON.parse(text)
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        !('nodes' in parsed) ||
        !Array.isArray(parsed.nodes) ||
        !('edges' in parsed) ||
        !Array.isArray(parsed.edges)
      ) {
        throw new Error('not a graph document: expected nodes and edges arrays')
      }
      // The server validates the full document on run; the canvas only needs
      // the shape to render it, and importing @z1/graph would pull node:crypto
      // into the browser bundle.
      loadGraph(parsed as GraphDocument)
      setOpenError(null)
    } catch (error) {
      setOpenError(error instanceof Error ? error.message : String(error))
    }
  }

  const connected = connection === 'connected'
  const running = runStatus === 'running'

  return (
    <header className="toolbar">
      <div className="brand">z1</div>
      <label className="field">
        <span>title</span>
        <input
          className="title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="graph title"
        />
      </label>
      <label className="field">
        <span>server</span>
        <input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="ws://127.0.0.1:43219"
          spellCheck={false}
        />
      </label>
      <label className="field">
        <span>token</span>
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder="server token"
          spellCheck={false}
        />
      </label>
      <button
        type="button"
        className="primary"
        data-testid="connect"
        onClick={() => {
          void (connected ? disconnect() : connectServer())
        }}
      >
        {connected ? 'Disconnect' : connection === 'connecting' ? 'Connecting…' : 'Connect'}
      </button>
      <span className={`status status-${connection}`} title={connectionError ?? connection}>
        {connection}
      </span>
      <div className="toolbar-spacer" />
      <label className="field">
        <span>input</span>
        <textarea
          className="run-input"
          data-testid="run-input"
          value={runInput}
          onChange={(event) => setRunInput(event.target.value)}
          placeholder="JSON input (optional)"
          spellCheck={false}
          rows={1}
        />
      </label>
      <button
        type="button"
        className="primary"
        data-testid="run"
        onClick={() => void run()}
        disabled={!connected || running}
      >
        Run
      </button>
      <button
        type="button"
        data-testid="cancel"
        onClick={() => void cancel()}
        disabled={!connected || !running}
      >
        Cancel
      </button>
      <button type="button" onClick={save}>
        Save JSON
      </button>
      <button type="button" onClick={() => fileInput.current?.click()}>
        Open JSON
      </button>
      <input
        ref={fileInput}
        className="hidden-input"
        type="file"
        accept="application/json,.json"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file !== undefined) void open(file)
        }}
      />
      {openError !== null ? <span className="inline-error">{openError}</span> : null}
    </header>
  )
}
