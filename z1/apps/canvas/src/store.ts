/**
 * Canvas state: connection, descriptors, graph, run overlay and approvals.
 *
 * The connected client lives in a module variable rather than the store: it is
 * a live socket, not serializable UI state. Only the url and token persist.
 *
 * @module canvas/store
 */

import type { GraphDocument, GraphEdge, GraphNode, ValidationIssue } from '@z1/graph'
import type { ApprovalDecision, AutonomyMode, Json } from '@z1/node'
import {
  APP_ERRORS,
  JsonRpcFault,
  type ApprovalRequestParams,
  type AuditEntry,
  type GraphSummary,
  type ModuleSummary,
  type NodeDescriptor,
  type ProposalSummary,
  type RunGetResult,
  type RunListResult,
  type RunStatus,
  type SequencedEvent,
} from '@z1/protocol'
import {
  applyEdgeChanges,
  applyNodeChanges,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react'
import { create } from 'zustand'

import { CanvasClient, errorText, type RunEventNotification, type RunStatusNotification } from './api.ts'
import {
  canConnect,
  edgeStyle,
  fromFlow,
  handleId,
  mergeRunEvent,
  parseHandleId,
  toFlow,
  type ConnectShape,
  type NodeRunStatus,
  type RunGraphState,
  type Z1EdgeData,
  type Z1FlowEdge,
  type Z1FlowNode,
  type Z1NodeData,
} from './graph.ts'
import {
  applyNodeEvent,
  appendTimeline,
  nodeRunFor,
  nodeRunsFromEvents,
  type NodeRunState,
  type RunTimelineEntry,
} from './runs.ts'

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

/** One server approval waiting for the dialog. */
export interface ApprovalEntry {
  params: ApprovalRequestParams
  resolve: (decision: ApprovalDecision) => void
}

/** A stored run opened in the panel: its journal row and every event. */
export interface RunDetail {
  runId: string
  record: unknown
  events: unknown[]
}

export interface CanvasStore {
  url: string
  token: string
  connection: ConnectionState
  connectionError: string | null
  descriptors: NodeDescriptor[]
  nodes: Z1FlowNode[]
  edges: Z1FlowEdge[]
  selectedId: string | null
  title: string
  runId: string | null
  runStatus: RunStatus | null
  outputs: Record<string, Json>
  runError: string | null
  issues: ValidationIssue[]
  events: SequencedEvent[]
  nodeStatus: Record<string, NodeRunStatus>
  /** Last state of each execution path (`loop/0/chat`) in the current run. */
  nodeRun: Record<string, NodeRunState>
  /** Node-level timeline of the current run, capped at 2000 lines. */
  runTimeline: RunTimelineEntry[]
  /** The run selected in the runs panel, with its journal and events. */
  runDetail: RunDetail | null
  approvals: ApprovalEntry[]
  runs: RunListResult
  selectedRun: RunGetResult | null
  forkInput: string
  /** Raw JSON typed into the run input field; parsed when the run starts. */
  runInput: string
  runsOpen: boolean
  modules: ModuleSummary[]
  proposals: ProposalSummary[]
  moduleAudit: AuditEntry[]
  moduleError: string | null
  modulesOpen: boolean
  graphs: GraphSummary[]
  currentGraphId: string | null
  graphVersion: number
  graphDirty: boolean
  graphSaving: boolean
  graphError: string | null
  lastSavedAt: number | null

  setUrl(url: string): void
  setToken(token: string): void
  setTitle(title: string): void
  connectServer(): Promise<void>
  disconnect(): void
  addNode(key: string): void
  onNodesChange(changes: NodeChange<Z1FlowNode>[]): void
  onEdgesChange(changes: EdgeChange<Z1FlowEdge>[]): void
  connectNodes(connection: ConnectShape): void
  select(id: string | null): void
  updateConfig(id: string, config: Json): void
  setAutonomy(id: string, mode: AutonomyMode): void
  loadGraph(graph: GraphDocument): void
  run(): Promise<void>
  cancel(): Promise<void>
  ingestEvent(notification: RunEventNotification): void
  ingestStatus(notification: RunStatusNotification): void
  refreshRuns(): Promise<void>
  openRun(runId: string): Promise<void>
  selectRun(runId: string): Promise<void>
  setForkInput(value: string): void
  setRunInput(value: string): void
  forkRun(): Promise<void>
  forkAt(path: string): Promise<void>
  respondApproval(approvalId: string, decision: Extract<ApprovalDecision, 'allowed-once' | 'rejected'>): void
  toggleRunsPanel(): void
  refreshModules(): Promise<void>
  proposeModule(directory: string): Promise<void>
  approveModule(moduleId: string, version: string): Promise<void>
  rollbackModule(moduleId: string): Promise<void>
  loadAudit(): Promise<void>
  toggleModulesPanel(): void
  refreshGraphs(): Promise<void>
  openGraph(id: string): Promise<void>
  saveGraph(): Promise<void>
  deleteGraph(id: string): Promise<void>
  newGraph(template: 'empty' | 'hello'): void
  markDirty(): void
}

const STORAGE_URL = 'z1.canvas.url'
const STORAGE_TOKEN = 'z1.canvas.token'

function readStored(key: string): string {
  try {
    if (typeof localStorage === 'undefined') return ''
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

/** The connection the page should start with, before any user interaction. */
export interface InitialConnection {
  url: string
  token: string
}

/**
 * Read the initial connection from `?url=` and `?token=`.
 *
 * The CLI prints exactly those two query parameters, so a link must beat
 * whatever an earlier session left behind: localStorage is only a fallback for
 * a bare page load.
 */
export function readInitialConnection(): InitialConnection {
  let params: URLSearchParams | null = null
  try {
    if (typeof window !== 'undefined') params = new URLSearchParams(window.location.search)
  } catch {
    params = null
  }
  const queryUrl = params?.get('url')?.trim() ?? ''
  const queryToken = params?.get('token')?.trim() ?? ''
  if (queryUrl.length > 0) return { url: queryUrl, token: queryToken }
  return { url: readStored(STORAGE_URL), token: readStored(STORAGE_TOKEN) }
}

function writeStored(key: string, value: string): void {
  try {
    if (typeof localStorage === 'undefined') return
    localStorage.setItem(key, value)
  } catch {
    // Storage can be full or blocked; the value still works for this session.
  }
}

let client: CanvasClient | null = null
/** Notification/close subscriptions of the current client, dropped on disconnect. */
let subscriptions: Array<() => void> = []

function unsubscribeAll(): void {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe()
}

/** Apply the run status map onto React Flow nodes without keeping stale keys. */
function applyStatuses(
  nodes: readonly Z1FlowNode[],
  statuses: Record<string, NodeRunStatus>,
  nodeRuns: Readonly<Record<string, NodeRunState>> = {},
): Z1FlowNode[] {
  return nodes.map((node) => {
    const run = nodeRunFor(nodeRuns, node.id)
    const status = statuses[node.id] ?? run?.status
    const base: Z1NodeData = {
      descriptor: node.data.descriptor,
      config: node.data.config,
    }
    if (node.data.autonomy !== undefined) base.autonomy = node.data.autonomy
    if (status !== undefined) base.status = status
    if (run?.durationMs !== undefined) base.durationMs = run.durationMs
    return { ...node, data: base }
  })
}

/** Parse the run input field; `null` means "invalid JSON". */
function parseRunInput(raw: string): { ok: true; input?: Json } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: true }
  try {
    return { ok: true, input: JSON.parse(trimmed) as Json }
  } catch (error) {
    return { ok: false, error: `run input is not valid JSON: ${errorText(error)}` }
  }
}

/** Pick the next grid slot not already taken by a node. */
function freePosition(nodes: readonly Z1FlowNode[]): { x: number; y: number } {
  const stepX = 260
  const stepY = 168
  const columns = 3
  const occupied = new Set(nodes.map((node) => `${String(node.position.x)},${String(node.position.y)}`))
  for (let index = nodes.length; index < nodes.length + 240; index++) {
    const x = 60 + (index % columns) * stepX
    const y = 60 + Math.floor(index / columns) * stepY
    if (!occupied.has(`${String(x)},${String(y)}`)) return { x, y }
  }
  return { x: 60, y: 60 }
}

function uniqueNodeId(nodes: readonly Z1FlowNode[], descriptor: NodeDescriptor): string {
  const base = descriptor.id.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node'
  const taken = new Set(nodes.map((node) => node.id))
  for (let index = 1; ; index++) {
    const candidate = `${base}-${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Copy JSON so a palette default or a loaded graph is never mutated in place. */
function cloneJson(value: Json | undefined): Json {
  if (value === undefined) return {}
  return JSON.parse(JSON.stringify(value)) as Json
}

/** A path-safe graph id the server will accept, derived from the title. */
function graphIdFromTitle(title: string, taken: ReadonlySet<string>): string {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 64)
  const base = slug.length > 0 ? slug : 'untitled'
  for (let index = 1; ; index++) {
    const candidate = index === 1 ? base : `${base}-${String(index)}`
    if (!taken.has(candidate)) return candidate
  }
}

const AUTOSAVE_MS = 1500
let autosaveTimer: ReturnType<typeof setTimeout> | null = null

function cancelAutosave(): void {
  if (autosaveTimer === null) return
  clearTimeout(autosaveTimer)
  autosaveTimer = null
}

/**
 * Debounce an autosave. The timer holds a store getter, not a snapshot: a run
 * may change the graph while the timer waits, and only unsaved work is written.
 */
function scheduleAutosave(get: () => CanvasStore): void {
  cancelAutosave()
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    const state = get()
    if (state.currentGraphId === null || !state.graphDirty) return
    if (state.graphSaving) {
      scheduleAutosave(get)
      return
    }
    void state.saveGraph()
  }, AUTOSAVE_MS)
}

function isConflict(error: unknown): boolean {
  return error instanceof JsonRpcFault && error.code === APP_ERRORS.conflict
}

/** `?graph=<id>` names a stored graph to open once the catalogue has loaded. */
function readQueryGraphId(): string | null {
  try {
    if (typeof window === 'undefined') return null
    const id = new URLSearchParams(window.location.search).get('graph')?.trim() ?? ''
    return id.length > 0 ? id : null
  } catch {
    return null
  }
}

function nodeVersion(descriptors: readonly NodeDescriptor[], id: string): string {
  return descriptors.find((descriptor) => descriptor.id === id)?.version ?? '1.0.0'
}

/** The two starter graphs, built from the descriptors the server sent. */
function buildNewGraph(
  template: 'empty' | 'hello',
  descriptors: readonly NodeDescriptor[],
): GraphDocument {
  const input: GraphNode = {
    id: 'input',
    type: 'z1.core.input',
    version: nodeVersion(descriptors, 'z1.core.input'),
    config: {},
    position: { x: 0, y: 0 },
  }
  const output: GraphNode = {
    id: 'output',
    type: 'z1.core.output',
    version: nodeVersion(descriptors, 'z1.core.output'),
    config: {},
    position: template === 'hello' ? { x: 520, y: 0 } : { x: 260, y: 0 },
  }
  if (template === 'empty') {
    const edges: GraphEdge[] = [
      {
        id: 'f-in-output',
        kind: 'flow',
        from: { node: 'input', port: 'out' },
        to: { node: 'output', port: 'in' },
      },
    ]
    return { schemaVersion: 1, id: 'empty', title: 'untitled', nodes: [input, output], edges }
  }
  const templateNode: GraphNode = {
    id: 'template',
    type: 'z1.core.template',
    version: nodeVersion(descriptors, 'z1.core.template'),
    config: { template: 'hello {{name}}' },
    position: { x: 260, y: 0 },
  }
  const edges: GraphEdge[] = [
    {
      id: 'e-in-vars',
      kind: 'data',
      from: { node: 'input', port: 'value' },
      to: { node: 'template', port: 'vars' },
    },
    {
      id: 'e-template-value',
      kind: 'data',
      from: { node: 'template', port: 'text' },
      to: { node: 'output', port: 'value' },
    },
    {
      id: 'f-in-output',
      kind: 'flow',
      from: { node: 'input', port: 'out' },
      to: { node: 'output', port: 'in' },
    },
  ]
  return {
    schemaVersion: 1,
    id: 'hello',
    title: 'Hello',
    nodes: [input, templateNode, output],
    edges,
  }
}


function runGraphState(state: CanvasStore): RunGraphState {
  const view: RunGraphState = { nodeStatus: state.nodeStatus }
  if (state.runError !== null) view.error = state.runError
  return view
}

export const useCanvas = create<CanvasStore>()((set, get) => ({
  url: readStored(STORAGE_URL),
  token: readStored(STORAGE_TOKEN),
  connection: 'idle',
  connectionError: null,
  descriptors: [],
  nodes: [],
  edges: [],
  selectedId: null,
  title: 'untitled',
  runId: null,
  runStatus: null,
  outputs: {},
  runError: null,
  issues: [],
  events: [],
  nodeStatus: {},
  nodeRun: {},
  runTimeline: [],
  runDetail: null,
  approvals: [],
  runs: [],
  selectedRun: null,
  forkInput: '',
  runInput: '',
  runsOpen: false,
  modules: [],
  proposals: [],
  moduleAudit: [],
  moduleError: null,
  modulesOpen: false,
  graphs: [],
  currentGraphId: null,
  graphVersion: 0,
  graphDirty: false,
  graphSaving: false,
  graphError: null,
  lastSavedAt: null,

  setUrl(url) {
    writeStored(STORAGE_URL, url)
    set({ url })
  },

  setToken(token) {
    writeStored(STORAGE_TOKEN, token)
    set({ token })
  },

  setTitle(title) {
    set({ title })
    get().markDirty()
  },

  async connectServer() {
    unsubscribeAll()
    client?.close()
    client = null
    set({ connection: 'connecting', connectionError: null, descriptors: [] })
    try {
      const next = await CanvasClient.connect(get().url, get().token)
      client = next
      subscriptions = [
        next.onClose(() => {
          if (client !== next) return
          unsubscribeAll()
          client = null
          set({ connection: 'idle', connectionError: 'connection closed' })
        }),
        next.onRunEvent((notification) => get().ingestEvent(notification)),
        next.onRunStatus((notification) => get().ingestStatus(notification)),
      ]
      next.onApprovalRequest(
        (params) =>
          new Promise<ApprovalDecision>((resolve) => {
            set((state) => ({ approvals: [...state.approvals, { params, resolve }] }))
          }),
      )
      await next.initialize('z1-canvas')
      const [descriptors, runs] = await Promise.all([next.nodeList(), next.runList()])
      set({ connection: 'connected', connectionError: null, descriptors, runs })
      await get().refreshModules()
      await get().refreshGraphs()
      const initialGraph = readQueryGraphId()
      if (initialGraph !== null) await get().openGraph(initialGraph)
    } catch (error) {
      unsubscribeAll()
      client = null
      set({ connection: 'error', connectionError: errorText(error) })
    }
  },

  disconnect() {
    const active = client
    client = null
    cancelAutosave()
    unsubscribeAll()
    active?.close()
    set({ connection: 'idle', connectionError: null, graphSaving: false })
  },

  addNode(key) {
    const descriptor = get().descriptors.find(
      (candidate) => `${candidate.id}@${candidate.version}` === key,
    )
    if (descriptor === undefined) return
    const nodes = get().nodes
    const id = uniqueNodeId(nodes, descriptor)
    const node: Z1FlowNode = {
      id,
      type: 'z1',
      position: freePosition(nodes),
      data: { descriptor, config: cloneJson(descriptor.defaultConfig) },
    }
    set({ nodes: [...nodes, node], selectedId: id })
    get().markDirty()
  },

  onNodesChange(changes) {
    const nodes = applyNodeChanges(changes, get().nodes)
    const selectedId = get().selectedId
    const stillThere = selectedId === null || nodes.some((node) => node.id === selectedId)
    set({ nodes, ...(stillThere ? {} : { selectedId: null }) })
    // Selection and measurement churn on every render; only geometry and
    // structure changes belong in a saved graph.
    const structural = changes.some(
      (change) =>
        change.type === 'add' ||
        change.type === 'remove' ||
        change.type === 'replace' ||
        change.type === 'position',
    )
    if (structural) get().markDirty()
  },

  onEdgesChange(changes) {
    set({ edges: applyEdgeChanges(changes, get().edges) })
    const structural = changes.some(
      (change) => change.type === 'add' || change.type === 'remove' || change.type === 'replace',
    )
    if (structural) get().markDirty()
  },

  connectNodes(connection) {
    const { nodes, edges, descriptors } = get()
    if (!canConnect(connection, nodes, descriptors, edges)) return
    const from = parseHandleId(connection.sourceHandle)
    const to = parseHandleId(connection.targetHandle)
    if (from === undefined || to === undefined || connection.source === null) return
    const id = `${from.node}:${from.port}->${to.node}:${to.port}`
    if (edges.some((edge) => edge.id === id)) return
    const data: Z1EdgeData = { kind: from.kind }
    const edge: Z1FlowEdge = {
      id,
      source: connection.source,
      target: to.node,
      sourceHandle: handleId(from.node, from.port, from.kind),
      targetHandle: handleId(to.node, to.port, to.kind),
      type: 'smoothstep',
      data,
      style: edgeStyle(from.kind),
    }
    set({ edges: [...edges, edge] })
    get().markDirty()
  },

  select(id) {
    set({ selectedId: id })
  },

  updateConfig(id, config) {
    set({
      nodes: get().nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, config } } : node,
      ),
    })
    get().markDirty()
  },

  setAutonomy(id, mode) {
    set({
      nodes: get().nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, autonomy: mode } } : node,
      ),
    })
    get().markDirty()
  },

  loadGraph(graph) {
    const flow = toFlow(graph, get().descriptors)
    cancelAutosave()
    set({
      nodes: flow.nodes,
      edges: flow.edges,
      title: graph.title ?? '',
      selectedId: null,
      runId: null,
      runStatus: null,
      outputs: {},
      runError: null,
      issues: [],
      events: [],
      nodeStatus: {},
      nodeRun: {},
      runTimeline: [],
      runDetail: null,
      selectedRun: null,
      // An imported file is a new document, not the stored graph it may have
      // come from; saving must not overwrite that graph by accident.
      currentGraphId: null,
      graphVersion: 0,
      graphDirty: true,
      graphSaving: false,
      graphError: null,
      lastSavedAt: null,
    })
  },

  async run() {
    const active = client
    if (active === null) {
      set({ runError: 'connect to a z1 server first' })
      return
    }
    if (get().runStatus === 'running') return
    const parsedInput = parseRunInput(get().runInput)
    if (!parsedInput.ok) {
      set({ runError: parsedInput.error })
      return
    }
    const { input } = parsedInput
    const graph = fromFlow(get().nodes, get().edges, get().title)
    set({
      runId: null,
      runStatus: 'running',
      outputs: {},
      runError: null,
      issues: [],
      events: [],
      nodeStatus: {},
      nodeRun: {},
      runTimeline: [],
      runDetail: null,
      nodes: applyStatuses(get().nodes, {}),
    })
    try {
      const validation = await active.graphValidate(graph)
      if (!validation.ok) {
        set({
          runStatus: 'failed',
          runError: 'graph is invalid',
          issues: validation.issues,
        })
        return
      }
      const reply = await active.runStart(input === undefined ? { graph } : { graph, input })
      set({
        runId: reply.runId,
        runStatus: reply.status,
        outputs: reply.outputs,
        runError: reply.error ?? null,
      })
      await get().refreshRuns()
    } catch (error) {
      set({ runStatus: 'failed', runError: errorText(error) })
    }
  },

  async cancel() {
    const active = client
    const runId = get().runId
    if (active === null || runId === null) return
    try {
      await active.runCancel(runId)
      set({ runStatus: 'cancelled' })
    } catch (error) {
      set({ runError: errorText(error) })
    }
  },

  ingestEvent(notification) {
    const state = get()
    // Events also arrive for runs subscribed elsewhere; the canvas shows one.
    if (state.runId !== null && state.runId !== notification.runId) return
    if (state.events.some((entry) => entry.seq === notification.seq)) return
    const event = notification.event
    const merged = mergeRunEvent(runGraphState(state), event)
    const events = [...state.events, { seq: notification.seq, event }]
    let nodeRun = state.nodeRun
    let runTimeline = state.runTimeline
    let runDetail = state.runDetail
    if (event.type === 'run.started') {
      // A new run starts with a clean overlay: ids from the previous run would
      // otherwise make a fresh node look finished or failed.
      nodeRun = {}
      runTimeline = []
      runDetail = null
    } else {
      const update = applyNodeEvent(nodeRun, notification.seq, event)
      if (update !== null) {
        nodeRun = update.nodeRun
        runTimeline = appendTimeline(runTimeline, update.timeline)
      }
    }
    // Outputs only ever arrive with `run.completed`; keeping them here means a
    // live run fills the panel before its `run.start` reply returns.
    const completed = event.type === 'run.completed' ? event.outputs : null
    set({
      runId: state.runId ?? notification.runId,
      nodeStatus: merged.nodeStatus,
      nodeRun,
      runTimeline,
      runDetail,
      runError: merged.error ?? null,
      events: events.slice(-500),
      nodes: applyStatuses(state.nodes, merged.nodeStatus, nodeRun),
      ...(completed === null ? {} : { outputs: completed }),
    })
  },

  ingestStatus(notification) {
    const state = get()
    if (state.runId !== null && state.runId !== notification.runId) return
    set({ runId: state.runId ?? notification.runId, runStatus: notification.status })
  },

  async refreshRuns() {
    const active = client
    if (active === null) return
    try {
      set({ runs: await active.runList() })
    } catch (error) {
      set({ connectionError: errorText(error) })
    }
  },

  async openRun(runId) {
    await get().selectRun(runId)
  },

  async selectRun(runId) {
    const active = client
    if (active === null) return
    try {
      const result = await active.runGet(runId)
      let view: RunGraphState = { nodeStatus: {} }
      let outputs: Record<string, Json> = {}
      for (const entry of result.events) {
        view = mergeRunEvent(view, entry.event)
        if (entry.event.type === 'run.completed') outputs = entry.event.outputs
      }
      const folded = nodeRunsFromEvents(result.events)
      set({
        runDetail: { runId, record: result.record, events: result.events },
        selectedRun: result,
        runId: runId,
        runStatus: result.record.status,
        outputs,
        nodeStatus: view.nodeStatus,
        nodeRun: folded.nodeRun,
        runTimeline: folded.timeline,
        runError: view.error ?? null,
        nodes: applyStatuses(get().nodes, view.nodeStatus, folded.nodeRun),
        runsOpen: true,
      })
    } catch (error) {
      set({ runError: errorText(error) })
    }
  },

  setForkInput(value) {
    set({ forkInput: value })
  },

  setRunInput(value) {
    set({ runInput: value })
  },

  async forkRun() {
    const active = client
    const selected = get().selectedRun
    if (active === null || selected === null) return
    const raw = get().forkInput.trim().length > 0 ? get().forkInput.trim() : (get().selectedId ?? '')
    if (raw.length === 0) {
      set({ runError: 'fork needs a node path or a sequence number' })
      return
    }
    await get().forkAt(raw)
  },

  async forkAt(path) {
    const active = client
    const state = get()
    // A live run has no selected journal row yet; its `runId` is the parent.
    const parentRunId = state.selectedRun?.record.runId ?? state.runId
    if (active === null || parentRunId === null) {
      set({ runError: 'fork needs a stored run to branch from' })
      return
    }
    const raw = path.trim()
    if (raw.length === 0) {
      set({ runError: 'fork needs a node path or a sequence number' })
      return
    }
    if (get().runStatus === 'running') return
    // A fork is a journal prefix, but the branch still needs the input the
    // original run was started with: resume replays nodes, not the entry input.
    const parsedInput = parseRunInput(get().runInput)
    if (!parsedInput.ok) {
      set({ runError: parsedInput.error })
      return
    }
    const { input } = parsedInput
    const graph = fromFlow(get().nodes, get().edges, get().title)
    try {
      const fork = /^\d+$/.test(raw) ? { atSeq: Number(raw) } : { nodePath: raw }
      const result = await active.runFork(parentRunId, fork)
      set({
        runId: result.runId,
        runStatus: 'running',
        runError: null,
        outputs: {},
        events: [],
        nodeStatus: {},
        nodeRun: {},
        runTimeline: [],
        runDetail: null,
        selectedRun: null,
        nodes: applyStatuses(get().nodes, {}),
      })
      // A fork is only a journal prefix: the branch continues by resuming it.
      // Status and outputs then arrive as `run.status`/`run.event` notifications.
      const reply = await active.runResume(
        input === undefined ? { runId: result.runId, graph } : { runId: result.runId, graph, input },
      )
      // A resume rejected before execution reports failure in the reply rather
      // than throwing (e.g. a graph that no longer matches the journal).
      if (reply.status === 'failed') {
        set({ runStatus: 'failed', runError: reply.error ?? 'run failed' })
      }
    } catch (error) {
      set({ runStatus: 'failed', runError: errorText(error) })
    } finally {
      await get().refreshRuns()
    }
  },

  respondApproval(approvalId, decision) {
    const state = get()
    const entry = state.approvals.find((candidate) => candidate.params.approvalId === approvalId)
    // An unknown id was already answered (or its run went away): drop nothing.
    if (entry === undefined) return
    entry.resolve(decision)
    set({ approvals: state.approvals.filter((candidate) => candidate !== entry) })
  },

  toggleRunsPanel() {
    set({ runsOpen: !get().runsOpen })
  },

  async refreshModules() {
    const active = client
    if (active === null) return
    try {
      const list = await active.moduleList()
      set({ modules: list.modules, proposals: list.proposals, moduleError: null })
    } catch (error) {
      set({ moduleError: errorText(error) })
    }
  },

  async proposeModule(directory) {
    const active = client
    if (active === null) return
    try {
      await active.modulePropose(directory)
      await get().refreshModules()
    } catch (error) {
      set({ moduleError: errorText(error) })
    }
  },

  async approveModule(moduleId, version) {
    const active = client
    if (active === null) return
    try {
      await active.moduleApprove(moduleId, version)
      // Approval changes both the module list and the declared node catalogue,
      // so the palette must be reloaded from the server, not patched locally.
      const [descriptors, list] = await Promise.all([active.nodeList(), active.moduleList()])
      set({
        descriptors,
        modules: list.modules,
        proposals: list.proposals,
        moduleError: null,
      })
    } catch (error) {
      set({ moduleError: errorText(error) })
    }
  },

  async rollbackModule(moduleId) {
    const active = client
    if (active === null) return
    try {
      await active.moduleRollback(moduleId)
      const [descriptors, list] = await Promise.all([active.nodeList(), active.moduleList()])
      set({
        descriptors,
        modules: list.modules,
        proposals: list.proposals,
        moduleError: null,
      })
    } catch (error) {
      set({ moduleError: errorText(error) })
    }
  },

  async loadAudit() {
    const active = client
    if (active === null) return
    try {
      set({ moduleAudit: await active.moduleAudit(), moduleError: null })
    } catch (error) {
      set({ moduleError: errorText(error) })
    }
  },

  toggleModulesPanel() {
    set({ modulesOpen: !get().modulesOpen })
  },

  async refreshGraphs() {
    const active = client
    if (active === null) return
    try {
      const list = await active.graphList()
      set({ graphs: list.graphs })
    } catch (error) {
      set({ graphError: errorText(error) })
    }
  },

  async openGraph(id) {
    const active = client
    if (active === null) {
      set({ graphError: 'connect to a z1 server first' })
      return
    }
    cancelAutosave()
    try {
      const result = await active.graphGet(id)
      const flow = toFlow(result.graph, get().descriptors)
      set({
        currentGraphId: id,
        graphVersion: result.version,
        graphDirty: false,
        graphSaving: false,
        graphError: null,
        lastSavedAt: result.updatedAt,
        nodes: flow.nodes,
        edges: flow.edges,
        title: result.graph.title ?? '',
        selectedId: null,
        runId: null,
        runStatus: null,
        outputs: {},
        runError: null,
        issues: [],
        events: [],
        nodeStatus: {},
        nodeRun: {},
        runTimeline: [],
        runDetail: null,
        selectedRun: null,
      })
    } catch (error) {
      set({ graphError: errorText(error) })
    }
  },

  async saveGraph() {
    const active = client
    if (active === null) {
      set({ graphError: 'connect to a z1 server first' })
      return
    }
    const state = get()
    if (state.graphSaving) return
    // A brand-new graph has no id yet: pick a free one from the catalogue and
    // claim version 0, so a save can never silently overwrite another graph.
    const taken = new Set(state.graphs.map((summary) => summary.id))
    const id = state.currentGraphId ?? graphIdFromTitle(state.title, taken)
    const graph: GraphDocument = { ...fromFlow(state.nodes, state.edges, state.title), id }
    const expectedVersion = state.currentGraphId === null ? 0 : state.graphVersion
    set({ graphSaving: true, graphError: null })
    try {
      const result = await active.graphSave({ graph, expectedVersion })
      set({
        currentGraphId: result.id,
        graphVersion: result.version,
        lastSavedAt: result.updatedAt,
        graphDirty: false,
        graphSaving: false,
        graphError: null,
      })
      // The in-memory graph is the run source; waiting for the list refresh
      // here would only delay the toolbar, never a run.
      await get().refreshGraphs()
    } catch (error) {
      set({
        graphSaving: false,
        graphDirty: true,
        graphError: isConflict(error)
          ? 'graph changed elsewhere — reload before saving'
          : errorText(error),
      })
    }
  },

  async deleteGraph(id) {
    const confirmed =
      typeof window === 'undefined' || window.confirm(`Delete graph "${id}"? This cannot be undone.`)
    if (!confirmed) return
    const active = client
    if (active === null) {
      set({ graphError: 'connect to a z1 server first' })
      return
    }
    try {
      await active.graphDelete(id)
      if (get().currentGraphId === id) {
        cancelAutosave()
        set({
          currentGraphId: null,
          graphVersion: 0,
          graphDirty: false,
          graphSaving: false,
          graphError: null,
          lastSavedAt: null,
          nodes: [],
          edges: [],
          title: '',
          selectedId: null,
        })
      }
      await get().refreshGraphs()
    } catch (error) {
      set({ graphError: errorText(error) })
    }
  },

  newGraph(template) {
    const document = buildNewGraph(template, get().descriptors)
    const flow = toFlow(document, get().descriptors)
    cancelAutosave()
    set({
      nodes: flow.nodes,
      edges: flow.edges,
      title: document.title ?? '',
      selectedId: null,
      runId: null,
      runStatus: null,
      outputs: {},
      runError: null,
      issues: [],
      events: [],
      nodeStatus: {},
      nodeRun: {},
      runTimeline: [],
      runDetail: null,
      selectedRun: null,
      // Until the first save the graph has no server identity; autosave stays
      // off so a scratch graph cannot appear in the library unasked.
      currentGraphId: null,
      graphVersion: 0,
      graphDirty: true,
      graphSaving: false,
      graphError: null,
      lastSavedAt: null,
    })
  },

  markDirty() {
    set({ graphDirty: true })
    if (get().currentGraphId === null) return
    scheduleAutosave(get)
  },
}))

/**
 * Seed url/token from the page query and report whether to auto-connect.
 *
 * Seeding does not persist: a shared `?token=` link must not overwrite the
 * token saved for a different server.
 */
export function applyInitialConnection(): boolean {
  const initial = readInitialConnection()
  useCanvas.setState({ url: initial.url, token: initial.token })
  return initial.url.trim().length > 0
}

