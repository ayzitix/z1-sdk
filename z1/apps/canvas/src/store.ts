/**
 * Canvas state: connection, descriptors, graph, run overlay and approvals.
 *
 * The connected client lives in a module variable rather than the store: it is
 * a live socket, not serializable UI state. Only the url and token persist.
 *
 * @module canvas/store
 */

import type { GraphDocument, ValidationIssue } from '@z1/graph'
import type { ApprovalDecision, AutonomyMode, Json } from '@z1/node'
import type {
  ApprovalRequestParams,
  NodeDescriptor,
  RunGetResult,
  RunListResult,
  RunStatus,
  SequencedEvent,
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

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error'

/** One server approval waiting for the dialog. */
export interface ApprovalEntry {
  params: ApprovalRequestParams
  resolve: (decision: ApprovalDecision) => void
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
  approvals: ApprovalEntry[]
  runs: RunListResult
  selectedRun: RunGetResult | null
  forkInput: string
  /** Raw JSON typed into the run input field; parsed when the run starts. */
  runInput: string
  runsOpen: boolean

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
  setForkInput(value: string): void
  setRunInput(value: string): void
  forkRun(): Promise<void>
  respondApproval(approvalId: string, decision: Extract<ApprovalDecision, 'allowed-once' | 'rejected'>): void
  toggleRunsPanel(): void
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
): Z1FlowNode[] {
  return nodes.map((node) => {
    const status = statuses[node.id]
    const base: Z1NodeData = {
      descriptor: node.data.descriptor,
      config: node.data.config,
    }
    if (node.data.autonomy !== undefined) base.autonomy = node.data.autonomy
    if (status !== undefined) base.status = status
    return { ...node, data: base }
  })
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
  approvals: [],
  runs: [],
  selectedRun: null,
  forkInput: '',
  runInput: '',
  runsOpen: false,

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
    } catch (error) {
      unsubscribeAll()
      client = null
      set({ connection: 'error', connectionError: errorText(error) })
    }
  },

  disconnect() {
    const active = client
    client = null
    unsubscribeAll()
    active?.close()
    set({ connection: 'idle', connectionError: null })
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
      data: { descriptor, config: {} },
    }
    set({ nodes: [...nodes, node], selectedId: id })
  },

  onNodesChange(changes) {
    const nodes = applyNodeChanges(changes, get().nodes)
    const selectedId = get().selectedId
    const stillThere = selectedId === null || nodes.some((node) => node.id === selectedId)
    set({ nodes, ...(stillThere ? {} : { selectedId: null }) })
  },

  onEdgesChange(changes) {
    set({ edges: applyEdgeChanges(changes, get().edges) })
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
  },

  setAutonomy(id, mode) {
    set({
      nodes: get().nodes.map((node) =>
        node.id === id ? { ...node, data: { ...node.data, autonomy: mode } } : node,
      ),
    })
  },

  loadGraph(graph) {
    const flow = toFlow(graph, get().descriptors)
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
      selectedRun: null,
    })
  },

  async run() {
    const active = client
    if (active === null) {
      set({ runError: 'connect to a z1 server first' })
      return
    }
    if (get().runStatus === 'running') return
    const rawInput = get().runInput.trim()
    let input: Json | undefined
    if (rawInput.length > 0) {
      try {
        input = JSON.parse(rawInput) as Json
      } catch (error) {
        set({ runError: `run input is not valid JSON: ${errorText(error)}` })
        return
      }
    }
    const graph = fromFlow(get().nodes, get().edges, get().title)
    set({
      runId: null,
      runStatus: 'running',
      outputs: {},
      runError: null,
      issues: [],
      events: [],
      nodeStatus: {},
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
    const merged = mergeRunEvent(runGraphState(state), notification.event)
    const events = [...state.events, { seq: notification.seq, event: notification.event }]
    // Outputs only ever arrive with `run.completed`; keeping them here means a
    // live run fills the panel before its `run.start` reply returns.
    const completed = notification.event.type === 'run.completed' ? notification.event.outputs : null
    set({
      runId: state.runId ?? notification.runId,
      nodeStatus: merged.nodeStatus,
      runError: merged.error ?? null,
      events: events.slice(-500),
      nodes: applyStatuses(state.nodes, merged.nodeStatus),
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
      set({
        selectedRun: result,
        runId: runId,
        runStatus: result.record.status,
        outputs,
        nodeStatus: view.nodeStatus,
        runError: view.error ?? null,
        nodes: applyStatuses(get().nodes, view.nodeStatus),
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
    if (get().runStatus === 'running') return
    const graph = fromFlow(get().nodes, get().edges, get().title)
    try {
      const fork = /^\d+$/.test(raw) ? { atSeq: Number(raw) } : { nodePath: raw }
      const result = await active.runFork(selected.record.runId, fork)
      set({
        runId: result.runId,
        runStatus: 'running',
        runError: null,
        outputs: {},
        events: [],
        nodeStatus: {},
        nodes: applyStatuses(get().nodes, {}),
      })
      // A fork is only a journal prefix: the branch continues by resuming it.
      // Status and outputs then arrive as `run.status`/`run.event` notifications.
      const reply = await active.runResume({ runId: result.runId, graph })
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

