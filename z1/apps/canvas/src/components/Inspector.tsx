import type { AutonomyMode, Json } from '@z1/node'
import { useEffect, useRef, useState, type ReactElement } from 'react'

import { useCanvas } from '../store.ts'

const AUTONOMY: readonly AutonomyMode[] = ['auto', 'ask', 'deny']

/** Must match the `slot` enum of the `z1.prompt.section` config schema. */
const SLOTS = ['core', 'role', 'task', 'context', 'contract', 'custom'] as const
type PromptSlot = (typeof SLOTS)[number]

const VARIABLE_HINT = 'Variables: {{memory}}, {{tools}}, {{autonomy}}'

function isRecord(value: Json): value is Record<string, Json> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A config is always an object in practice, but a hand-written graph may not be. */
function configRecord(config: Json): Record<string, Json> {
  return isRecord(config) ? config : {}
}

function readString(record: Record<string, Json>, key: string, fallback: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : fallback
}

function readNumber(record: Record<string, Json>, key: string, fallback: number): number {
  const value = record[key]
  return typeof value === 'number' ? value : fallback
}

function isSlot(value: string): value is PromptSlot {
  return (SLOTS as readonly string[]).includes(value)
}

interface PromptBodyProps {
  testId: string
  value: string
  onChange: (value: string) => void
}

/** Monospace body field that grows with its content; CSS caps it at 40vh. */
function PromptBody({ testId, value, onChange }: PromptBodyProps): ReactElement {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const element = ref.current
    if (element === null) return
    element.style.height = 'auto'
    element.style.height = `${String(element.scrollHeight)}px`
  }, [value])
  return (
    <textarea
      ref={ref}
      className="prompt-body"
      data-testid={testId}
      rows={12}
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

interface PromptEditorProps {
  config: Json
  nodeId: string
  onApply: (config: Json) => void
}

/** Structured editor for `z1.prompt.section`: one templated stack fragment. */
function PromptSectionEditor({ config, nodeId, onApply }: PromptEditorProps): ReactElement {
  const record = configRecord(config)
  // A node added from the palette starts with `{}`: seed the id from the node.
  const [id, setId] = useState(() => readString(record, 'id', nodeId))
  const [slot, setSlot] = useState<PromptSlot>(() => {
    const value = readString(record, 'slot', 'core')
    return isSlot(value) ? value : 'core'
  })
  const [priority, setPriority] = useState(() => String(readNumber(record, 'priority', 0)))
  const [required, setRequired] = useState(() => record['required'] === true)
  const [body, setBody] = useState(() => readString(record, 'body', ''))
  const [error, setError] = useState<string | null>(null)

  const apply = (): void => {
    const trimmedId = id.trim()
    if (trimmedId.length === 0) {
      setError('id must not be empty')
      return
    }
    const rawPriority = priority.trim()
    if (rawPriority.length === 0 || !Number.isInteger(Number(rawPriority))) {
      setError('priority must be a whole number')
      return
    }
    setError(null)
    onApply({ ...record, id: trimmedId, slot, priority: Number(rawPriority), required, body })
  }

  return (
    <div className="prompt-form">
      <label className="prompt-field">
        <span>id</span>
        <input
          data-testid="prompt-id"
          value={id}
          spellCheck={false}
          onChange={(event) => setId(event.target.value)}
        />
      </label>
      <div className="prompt-grid">
        <label className="prompt-field">
          <span>slot</span>
          <select
            data-testid="prompt-slot"
            value={slot}
            onChange={(event) => {
              const value = event.target.value
              if (isSlot(value)) setSlot(value)
            }}
          >
            {SLOTS.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </select>
        </label>
        <label className="prompt-field">
          <span>priority</span>
          <input
            data-testid="prompt-priority"
            type="number"
            step={1}
            value={priority}
            onChange={(event) => setPriority(event.target.value)}
          />
        </label>
      </div>
      <label className="prompt-check">
        <input
          data-testid="prompt-required"
          type="checkbox"
          checked={required}
          onChange={(event) => setRequired(event.target.checked)}
        />
        <span>required</span>
      </label>
      <div className="prompt-field">
        <div className="prompt-label-row">
          <span>body</span>
          <span className="prompt-meta">{body.length} chars</span>
        </div>
        <PromptBody testId="prompt-body" value={body} onChange={setBody} />
      </div>
      <p className="prompt-hint">{VARIABLE_HINT}</p>
      {error === null ? null : <p className="inline-error">{error}</p>}
      <div className="prompt-actions">
        <button type="button" data-testid="prompt-apply" onClick={apply}>
          Apply
        </button>
      </div>
    </div>
  )
}

/** Structured editor for `z1.prompt.text`: one literal prompt body. */
function PromptTextEditor({ config, onApply }: PromptEditorProps): ReactElement {
  const record = configRecord(config)
  const [text, setText] = useState(() => readString(record, 'text', ''))

  return (
    <div className="prompt-form">
      <div className="prompt-field">
        <div className="prompt-label-row">
          <span>text</span>
          <span className="prompt-meta">{text.length} chars</span>
        </div>
        <PromptBody testId="prompt-body" value={text} onChange={setText} />
      </div>
      <div className="prompt-actions">
        <button
          type="button"
          data-testid="prompt-apply"
          onClick={() => onApply({ ...record, text })}
        >
          Apply
        </button>
      </div>
    </div>
  )
}

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

  const isSection = descriptor.id === 'z1.prompt.section'
  const isPromptText = descriptor.id === 'z1.prompt.text'
  const isStack = descriptor.id === 'z1.prompt.stack'
  const stackBudget = configRecord(node.data.config)['budgetTokens']
  // Remount the structured editor whenever the stored config changes, so a
  // selection switch or an external load never leaves a stale draft behind.
  const draftKey = `${node.id}:${configText}`

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
        {isSection ? (
          <PromptSectionEditor
            key={draftKey}
            nodeId={node.id}
            config={node.data.config}
            onApply={(config) => updateConfig(node.id, config)}
          />
        ) : null}
        {isPromptText ? (
          <PromptTextEditor
            key={draftKey}
            nodeId={node.id}
            config={node.data.config}
            onApply={(config) => updateConfig(node.id, config)}
          />
        ) : null}
        {isStack ? (
          <p className="prompt-hint" data-testid="prompt-stack-hint">
            budgetTokens: {typeof stackBudget === 'number' ? String(stackBudget) : 'unset'} · Run the
            graph to see rendered tokens and hash
          </p>
        ) : null}
        {isSection || isPromptText ? null : (
          <>
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
          </>
        )}
      </div>
    </section>
  )
}
