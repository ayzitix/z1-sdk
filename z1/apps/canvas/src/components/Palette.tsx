import type { NodeDescriptor } from '@z1/protocol'
import type { ReactElement } from 'react'

import { useCanvas } from '../store.ts'

function groupsOf(descriptors: readonly NodeDescriptor[]): Array<[string, NodeDescriptor[]]> {
  const groups = new Map<string, NodeDescriptor[]>()
  for (const descriptor of descriptors) {
    const list = groups.get(descriptor.category) ?? []
    list.push(descriptor)
    groups.set(descriptor.category, list)
  }
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))
}

/** Registered node types, grouped by category; a click adds a node. */
export function Palette(): ReactElement {
  const descriptors = useCanvas((state) => state.descriptors)
  const addNode = useCanvas((state) => state.addNode)
  const groups = groupsOf(descriptors)

  return (
    <aside className="palette" data-testid="palette">
      <h2>nodes</h2>
      {groups.length === 0 ? (
        <p className="muted">Connect to the server to load node descriptors.</p>
      ) : (
        groups.map(([category, entries]) => (
          <section key={category} className="palette-group">
            <h3>{category}</h3>
            {entries.map((descriptor) => (
              <button
                key={`${descriptor.id}@${descriptor.version}`}
                type="button"
                className="palette-item"
                onClick={() => addNode(`${descriptor.id}@${descriptor.version}`)}
                title={`${descriptor.id}@${descriptor.version}`}
              >
                <span className="palette-item-title">{descriptor.title}</span>
                <span className="palette-item-type">
                  {descriptor.id}@{descriptor.version}
                </span>
              </button>
            ))}
          </section>
        ))
      )}
    </aside>
  )
}
