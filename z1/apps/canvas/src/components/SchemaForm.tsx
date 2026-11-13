/**
 * Config editor driven by a node's `configSchema`.
 *
 * The schema comes from `node.list` as plain JSON (zod's JSON-Schema output),
 * so this module only needs the small subset the node catalogue uses:
 * string/enum, number/integer, boolean and free-form object/array values.
 * Parsing is pure and exported, which is what the unit tests pin; the DOM part
 * is a thin mapping from fields to inputs.
 */

import type { Json } from '@z1/node'
import { useState, type ReactElement } from 'react'

export type SchemaFieldKind = 'enum' | 'text' | 'textarea' | 'number' | 'boolean' | 'json'

/** One editable property of a node's config object. */
export interface SchemaField {
  key: string
  label: string
  kind: SchemaFieldKind
  required: boolean
  description?: string
  /** String options for `enum` fields, empty otherwise. */
  options: string[]
  /** Whole numbers only. */
  integer: boolean
  /** Textarea height for `textarea` fields. */
  rows?: number
}

export type DraftValue = string | boolean
export type Draft = Record<string, DraftValue>

export type MergeResult =
  | { ok: true; config: Json }
  | { ok: false; errors: Record<string, string> }

/** Keys whose literal bodies are long enough to deserve a textarea. */
const TEXTAREA_KEYS = new Set(['body', 'text', 'template', 'description'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringOptions(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string')
}

/**
 * Project a config JSON Schema into the fields the form renders.
 *
 * `properties` is the only source of fields: a schema with no properties (an
 * unconstrained node) yields none, and the raw JSON editor is the whole form.
 */
export function fieldsFromSchema(
  schema: Record<string, unknown> | undefined,
): SchemaField[] {
  if (schema === undefined) return []
  const properties = schema['properties']
  if (!isRecord(properties)) return []
  const required = new Set(stringOptions(schema['required']))
  const fields: SchemaField[] = []
  for (const [key, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue
    const type = typeof raw['type'] === 'string' ? raw['type'] : undefined
    const options = stringOptions(raw['enum'])
    const description = typeof raw['description'] === 'string' ? raw['description'] : undefined
    const label = typeof raw['title'] === 'string' ? raw['title'] : key

    let kind: SchemaFieldKind
    if (options.length > 0 && (type === 'string' || type === undefined)) {
      kind = 'enum'
    } else if (type === 'string') {
      kind = TEXTAREA_KEYS.has(key) ? 'textarea' : 'text'
    } else if (type === 'number' || type === 'integer') {
      kind = 'number'
    } else if (type === 'boolean') {
      kind = 'boolean'
    } else {
      // Objects, arrays and schemas with no type are free-form JSON.
      kind = 'json'
    }

    const field: SchemaField = {
      key,
      label,
      kind,
      required: required.has(key),
      options,
      integer: type === 'integer',
    }
    if (description !== undefined) field.description = description
    if (kind === 'textarea') field.rows = 6
    fields.push(field)
  }
  return fields
}

function configRecord(config: Json): Record<string, Json> {
  return isRecord(config) ? (config as Record<string, Json>) : {}
}

/** Initial draft values: every field starts from the stored config. */
export function draftFromConfig(fields: readonly SchemaField[], config: Json): Draft {
  const record = configRecord(config)
  const draft: Draft = {}
  for (const field of fields) {
    const value = record[field.key]
    switch (field.kind) {
      case 'boolean':
        draft[field.key] = value === true
        break
      case 'json':
        draft[field.key] = value === undefined ? '' : JSON.stringify(value, null, 2)
        break
      case 'number':
        draft[field.key] = typeof value === 'number' ? String(value) : ''
        break
      default:
        draft[field.key] = typeof value === 'string' ? value : ''
        break
    }
  }
  return draft
}

/**
 * Merge a draft into the stored config, touching only the schema's keys.
 *
 * Keys the schema does not describe survive untouched, so a hand-written
 * config is never silently pruned by opening the form. A field whose draft
 * still matches the stored value is not written at all. An empty number or
 * JSON draft removes the key; a string draft always writes (an empty text is
 * data).
 */
export function mergeDraft(
  fields: readonly SchemaField[],
  config: Json,
  draft: Draft,
): MergeResult {
  const next: Record<string, Json> = { ...configRecord(config) }
  const initial = draftFromConfig(fields, config)
  const errors: Record<string, string> = {}

  for (const field of fields) {
    const raw = draft[field.key]
    // Only edited properties are written: an untouched empty text/checkbox
    // must not materialise as `""`/`false` in an otherwise sparse config.
    if (raw === initial[field.key]) continue
    switch (field.kind) {
      case 'boolean':
        next[field.key] = typeof raw === 'boolean' ? raw : false
        break
      case 'text':
      case 'textarea':
        next[field.key] = typeof raw === 'string' ? raw : ''
        break
      case 'enum': {
        const value = typeof raw === 'string' ? raw.trim() : ''
        if (value.length === 0) delete next[field.key]
        else next[field.key] = value
        break
      }
      case 'number': {
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (text.length === 0) {
          delete next[field.key]
          break
        }
        const value = Number(text)
        if (!Number.isFinite(value)) {
          errors[field.key] = `${field.label} must be a number`
        } else if (field.integer && !Number.isInteger(value)) {
          errors[field.key] = `${field.label} must be a whole number`
        } else {
          next[field.key] = value
        }
        break
      }
      case 'json': {
        const text = typeof raw === 'string' ? raw.trim() : ''
        if (text.length === 0) {
          delete next[field.key]
          break
        }
        try {
          next[field.key] = JSON.parse(text) as Json
        } catch (error) {
          errors[field.key] = `${field.label} is not valid JSON: ${
            error instanceof Error ? error.message : String(error)
          }`
        }
        break
      }
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  return { ok: true, config: next }
}

export interface SchemaFormProps {
  schema: Record<string, unknown>
  config: Json
  onApply: (config: Json) => void
}

interface FieldProps {
  field: SchemaField
  value: DraftValue
  onChange: (value: DraftValue) => void
}

function FieldInput({ field, value, onChange }: FieldProps): ReactElement {
  const testId = `schema-${field.key}`
  switch (field.kind) {
    case 'enum':
      return (
        <select
          data-testid={testId}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">—</option>
          {field.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )
    case 'textarea':
      return (
        <textarea
          data-testid={testId}
          rows={field.rows ?? 5}
          spellCheck={false}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'number':
      return (
        <input
          data-testid={testId}
          type="number"
          step={field.integer ? 1 : 'any'}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    case 'boolean':
      return (
        <label className="prompt-check">
          <input
            data-testid={testId}
            type="checkbox"
            checked={value === true}
            onChange={(event) => onChange(event.target.checked)}
          />
          <span>{field.label}</span>
        </label>
      )
    case 'json':
      return (
        <textarea
          data-testid={testId}
          className="config-editor"
          rows={4}
          spellCheck={false}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
        />
      )
    default:
      return (
        <input
          data-testid={testId}
          value={typeof value === 'string' ? value : ''}
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
      )
  }
}

/** Schema-driven config form with a raw-JSON escape hatch. */
export function SchemaForm({ schema, config, onApply }: SchemaFormProps): ReactElement {
  const fields = fieldsFromSchema(schema)
  const [draft, setDraft] = useState<Draft>(() => draftFromConfig(fields, config))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [raw, setRaw] = useState(() => JSON.stringify(config, null, 2))
  const [rawError, setRawError] = useState<string | null>(null)

  const apply = (): void => {
    const result = mergeDraft(fields, config, draft)
    if (!result.ok) {
      setErrors(result.errors)
      return
    }
    setErrors({})
    onApply(result.config)
  }

  const applyRaw = (): void => {
    try {
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) throw new Error('config must be a JSON object')
      setRawError(null)
      onApply(parsed as Json)
    } catch (error) {
      setRawError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="prompt-form schema-form">
      {fields.length === 0 ? (
        <p className="muted">this node accepts free-form JSON</p>
      ) : null}
      {fields.map((field) => (
        <div className="prompt-field" key={field.key}>
          {field.kind === 'boolean' ? null : (
            <span>
              {field.label}
              {field.required ? <span className="schema-required"> *</span> : null}
            </span>
          )}
          <FieldInput
            field={field}
            value={draft[field.key] ?? ''}
            onChange={(value) =>
              setDraft((current) => ({ ...current, [field.key]: value }))
            }
          />
          {field.description === undefined ? null : (
            <span className="schema-hint">{field.description}</span>
          )}
          {errors[field.key] === undefined ? null : (
            <span className="inline-error">{errors[field.key]}</span>
          )}
        </div>
      ))}
      {fields.length === 0 ? null : (
        <div className="prompt-actions">
          <button type="button" data-testid="schema-apply" onClick={apply}>
            Apply
          </button>
        </div>
      )}
      <details className="schema-raw">
        <summary>Raw JSON</summary>
        <textarea
          className="config-editor"
          data-testid="schema-raw"
          spellCheck={false}
          value={raw}
          onChange={(event) => setRaw(event.target.value)}
        />
        {rawError === null ? null : <p className="inline-error">{rawError}</p>}
        <button type="button" onClick={applyRaw}>
          Apply raw
        </button>
      </details>
    </div>
  )
}
