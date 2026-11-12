import type { AutonomyMode, Json } from '@z1/node'
import { useEffect, useState, type ReactElement } from 'react'

import { useCanvas } from '../store.ts'

const AUTONOMY: readonly AutonomyMode[] = ['auto', 'ask', 'deny']

/** Details and per-instance settings of the selected node. */
export function Inspector(): ReactElement {
  const node = useCanvas((state) => state.nodes.find((entry) => entry.id === state.selectedId) ?? null)
  const updateConfig = useCanvas((state) => state.updateConfig)
  const setAutonomy = useCanvas((state) => state.setAutonomy)
  const configText = node === null ? '' : JSON.stringify(node.data.config, null, 2)
  const [text, setText] = useState(configText)
  const [configError, setConfigError] = useState<string | null>(null)

  useEffect(() => {
    setText(configText)
    setConfigError(null)
  }, [configText])

  if (node === null) {
    return (
      <section className="panel inspector">
        <h2>inspector</h2>
        <p className="muted">Select a node to inspect its ports and configuration.</p>
      </section>
    )
  }

  const descriptor = node.data.descriptor
  const apply = (): void => {
    try {
      updateConfig(node.id, JSON.parse(text) as Json)
      setConfigError(null)
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <section className="panel inspector">
      <h2>inspector</h2>
      <div className="inspector-head">
        <span className="inspector-title">{descriptor.title}</span>
        <span className="inspector-type">
          {descriptor.id}@{descriptor.version}
        </span>
      </div>
      <div className="inspector-row">
        <span className="inspector-key">node</span>
        <code>{node.id}</code>
      </div>
      <div className="inspector-row">
        <span className="inspector-key">autonomy</span>
        <select
          value={node.data.autonomy ?? 'auto'}
          onChange={(event) => setAutonomy(node.id, event.target.value as AutonomyMode)}
        >
          {AUTONOMY.map((mode) => (
            <option key={mode} value={mode}>
              {mode}
            </option>
          ))}
        </select>
      </div>
      <div className="inspector-section">
        <h3>inputs</h3>
        {descriptor.inputs.length === 0 ? <p className="muted">none</p> : null}
        {descriptor.inputs.map((port) => (
          <div className="port-row" key={port.id}>
            <code>{port.id}</code>
            <span className="port-meta">
              {port.kind}
              {port.required === false ? ' · opt' : ''}
              {port.mode === 'stream' ? ' · stream' : ''}
            </span>
          </div>
        ))}
      </div>
      <div className="inspector-section">
        <h3>outputs</h3>
        {descriptor.outputs.length === 0 ? <p className="muted">none</p> : null}
        {descriptor.outputs.map((port) => (
          <div className="port-row" key={port.id}>
            <code>{port.id}</code>
            <span className="port-meta">{port.kind}</span>
          </div>
        ))}
      </div>
      <div className="inspector-section">
        <h3>config</h3>
        <textarea
          className="config-editor"
          value={text}
          spellCheck={false}
          onChange={(event) => setText(event.target.value)}
        />
        {configError === null ? null : <p className="inline-error">{configError}</p>}
        <button type="button" onClick={apply}>
          Apply
        </button>
      </div>
    </section>
  )
}
