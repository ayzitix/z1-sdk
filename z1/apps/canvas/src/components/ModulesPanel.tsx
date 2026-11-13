import type { ModuleSummary } from '@z1/protocol'
import { useState, type ReactElement } from 'react'

import { useCanvas } from '../store.ts'

function capabilitiesSummary(module: ModuleSummary): string {
  const { capabilities } = module
  const parts: string[] = []
  const fsRead = capabilities.fs?.read?.length ?? 0
  const fsWrite = capabilities.fs?.write?.length ?? 0
  if (fsRead > 0) parts.push(`fs.read ×${String(fsRead)}`)
  if (fsWrite > 0) parts.push(`fs.write ×${String(fsWrite)}`)
  const hosts = capabilities.net?.hosts?.length ?? 0
  if (hosts > 0) parts.push(`net ×${String(hosts)}`)
  const spawn = capabilities.process?.spawn?.length ?? 0
  if (spawn > 0) parts.push(`process ×${String(spawn)}`)
  if (capabilities.spend !== undefined) parts.push(`spend ${capabilities.spend.currency}`)
  const secrets = capabilities.secrets?.length ?? 0
  if (secrets > 0) parts.push(`secrets ×${String(secrets)}`)
  return parts.length === 0 ? 'no capabilities' : parts.join(' · ')
}

/** The version a rollback would restore: the nearest older installed one. */
function previousVersion(
  modules: readonly ModuleSummary[],
  module: ModuleSummary,
): string | undefined {
  const group = modules.filter((candidate) => candidate.moduleId === module.moduleId)
  const index = group.findIndex((candidate) => candidate.version === module.version)
  return index > 0 ? group[index - 1]?.version : undefined
}

/** Installed modules, inert proposals and the append-only audit log. */
export function ModulesPanel(): ReactElement {
  const open = useCanvas((state) => state.modulesOpen)
  const modules = useCanvas((state) => state.modules)
  const proposals = useCanvas((state) => state.proposals)
  const audit = useCanvas((state) => state.moduleAudit)
  const error = useCanvas((state) => state.moduleError)
  const toggleModulesPanel = useCanvas((state) => state.toggleModulesPanel)
  const refreshModules = useCanvas((state) => state.refreshModules)
  const proposeModule = useCanvas((state) => state.proposeModule)
  const approveModule = useCanvas((state) => state.approveModule)
  const rollbackModule = useCanvas((state) => state.rollbackModule)
  const loadAudit = useCanvas((state) => state.loadAudit)
  const [directory, setDirectory] = useState('')
  const [showAudit, setShowAudit] = useState(false)

  function toggleAudit(): void {
    const next = !showAudit
    setShowAudit(next)
    if (next) void loadAudit()
  }

  return (
    <section className={`runs-panel modules-panel${open ? ' is-open' : ''}`}>
      <div className="runs-header">
        <button
          type="button"
          className="runs-toggle"
          data-testid="modules-toggle"
          onClick={toggleModulesPanel}
        >
          {open ? '▾' : '▸'} modules
        </button>
        <span className="muted">
          {modules.length} installed · {proposals.length} proposed
        </span>
        <div className="toolbar-spacer" />
        <button type="button" data-testid="module-audit" onClick={toggleAudit}>
          {showAudit ? 'Hide audit' : 'Audit'}
        </button>
        <button type="button" onClick={() => void refreshModules()}>
          Refresh
        </button>
      </div>
      {open ? (
        <div className="modules-body">
          {error === null ? null : <p className="module-error">{error}</p>}

          <div className="modules-section">
            <h3>installed</h3>
            {modules.length === 0 ? <p className="muted">no modules installed</p> : null}
            {modules.map((module) => {
              const previous = module.active ? previousVersion(modules, module) : undefined
              return (
                <div
                  key={`${module.moduleId}@${module.version}`}
                  className="module-row"
                  data-testid={`module-row-${module.moduleId}`}
                >
                  <span className="module-id">
                    {module.moduleId}@{module.version}
                  </span>
                  {module.active ? <span className="module-badge">active</span> : null}
                  <span className="module-meta">{capabilitiesSummary(module)}</span>
                  <span className="module-meta">{module.nodes.length} nodes</span>
                  {previous === undefined ? null : (
                    <button
                      type="button"
                      data-testid={`module-rollback-${module.moduleId}`}
                      onClick={() => void rollbackModule(module.moduleId)}
                    >
                      Rollback to {previous}
                    </button>
                  )}
                </div>
              )
            })}
          </div>

          <div className="modules-section">
            <h3>proposals</h3>
            <div className="module-propose-bar">
              <input
                data-testid="module-propose-input"
                value={directory}
                placeholder="absolute module directory"
                spellCheck={false}
                onChange={(event) => setDirectory(event.target.value)}
              />
              <button
                type="button"
                data-testid="module-propose"
                disabled={directory.trim().length === 0}
                onClick={() => void proposeModule(directory.trim())}
              >
                Propose
              </button>
            </div>
            {proposals.length === 0 ? <p className="muted">no proposals</p> : null}
            {proposals.map((proposal) => (
              <div key={`${proposal.moduleId}@${proposal.version}`} className="module-row">
                <span className="module-id">
                  {proposal.moduleId}@{proposal.version}
                </span>
                <span className="module-meta">{proposal.title}</span>
                <button
                  type="button"
                  data-testid={`module-approve-${proposal.moduleId}`}
                  onClick={() => void approveModule(proposal.moduleId, proposal.version)}
                >
                  Approve
                </button>
              </div>
            ))}
          </div>

          {showAudit ? (
            <div className="modules-section module-audit-list">
              <h3>audit</h3>
              {audit.length === 0 ? <p className="muted">no audit entries</p> : null}
              {audit.map((entry) => (
                <div key={entry.seq} className="module-audit-row">
                  <span className="event-seq">#{entry.seq}</span>
                  <span className="event-label">{entry.type}</span>
                  <code className="event-path">
                    {entry.moduleId}@{entry.version}
                  </code>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
