import type { GraphDocument } from '@z1/graph'
import type { RunRecord } from '@z1/journal'
import { APP_ERRORS, JsonRpcFault } from '@z1/protocol'
import type { ApprovalRequestParams, NodeDescriptor, RunGetResult } from '@z1/protocol'
import type { Json } from '@z1/node'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RunEvent } from '../src/graph.ts'
import { nodeRunFor } from '../src/runs.ts'

/**
 * The store owns a live socket, so the tests replace `CanvasClient.connect`
 * with a fake and drive the pieces the UI would receive: notifications,
 * approval requests and the run lifecycle replies.
 */
interface FakeClient {
  onClose: ReturnType<typeof vi.fn>
  onRunEvent: ReturnType<typeof vi.fn>
  onRunStatus: ReturnType<typeof vi.fn>
  onApprovalRequest: ReturnType<typeof vi.fn>
  initialize: ReturnType<typeof vi.fn>
  nodeList: ReturnType<typeof vi.fn>
  runList: ReturnType<typeof vi.fn>
  graphValidate: ReturnType<typeof vi.fn>
  runStart: ReturnType<typeof vi.fn>
  runFork: ReturnType<typeof vi.fn>
  runResume: ReturnType<typeof vi.fn>
  runGet: ReturnType<typeof vi.fn>
  runCancel: ReturnType<typeof vi.fn>
  moduleList: ReturnType<typeof vi.fn>
  graphList: ReturnType<typeof vi.fn>
  graphGet: ReturnType<typeof vi.fn>
  graphSave: ReturnType<typeof vi.fn>
  graphDelete: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  /** Unsubscribers handed out by the handlers above. */
  unsubscribes: Array<ReturnType<typeof vi.fn>>
}

const fake: FakeClient = {
  onClose: vi.fn(),
  onRunEvent: vi.fn(),
  onRunStatus: vi.fn(),
  onApprovalRequest: vi.fn(),
  initialize: vi.fn(async () => ({
    serverName: 'z1',
    protocolVersion: '1',
    capabilities: { runs: true, approvals: true, modules: false },
  })),
  nodeList: vi.fn(async () => []),
  runList: vi.fn(async () => []),
  graphValidate: vi.fn(async () => ({ ok: true, issues: [] })),
  runStart: vi.fn(),
  runFork: vi.fn(),
  runResume: vi.fn(async () => ({
    runId: 'run_fork',
    status: 'completed',
    outputs: {},
  })),
  runGet: vi.fn(),
  runCancel: vi.fn(async () => ({})),
  moduleList: vi.fn(async () => ({ modules: [], proposals: [] })),
  graphList: vi.fn(async () => ({ graphs: [] })),
  graphGet: vi.fn(),
  graphSave: vi.fn(),
  graphDelete: vi.fn(async () => ({})),
  close: vi.fn(),
  unsubscribes: [],
}

vi.mock('../src/api.ts', () => ({
  CanvasClient: { connect: async () => fake },
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

const { useCanvas } = await import('../src/store.ts')

function resetClientMocks(): void {
  for (const unsubscribe of fake.unsubscribes.splice(0)) unsubscribe()
  for (const method of [
    fake.onClose,
    fake.onRunEvent,
    fake.onRunStatus,
    fake.onApprovalRequest,
    fake.initialize,
    fake.nodeList,
    fake.runList,
    fake.runFork,
    fake.runResume,
    fake.runGet,
    fake.moduleList,
    fake.graphList,
    fake.graphGet,
    fake.graphSave,
    fake.graphDelete,
    fake.close,
  ]) {
    method.mockClear()
  }
  fake.runList.mockResolvedValue([])
  fake.graphList.mockResolvedValue({ graphs: [] })
  fake.initialize.mockResolvedValue({
    serverName: 'z1',
    protocolVersion: '1',
    capabilities: { runs: true, approvals: true, modules: false },
  })
  fake.runResume.mockResolvedValue({ runId: 'run_fork', status: 'completed', outputs: {} })
}

beforeEach(async () => {
  resetClientMocks()
  useCanvas.setState({
    url: 'ws://127.0.0.1:1',
    token: 't',
    connection: 'idle',
    connectionError: null,
    descriptors: [],
    nodes: [],
    edges: [],
    selectedId: null,
    title: 'test',
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
    graphs: [],
    currentGraphId: null,
    graphVersion: 0,
    graphDirty: false,
    graphSaving: false,
    graphError: null,
    lastSavedAt: null,
  })
  for (const method of [fake.onClose, fake.onRunEvent, fake.onRunStatus]) {
    const unsubscribe = vi.fn()
    fake.unsubscribes.push(unsubscribe)
    method.mockImplementation(() => unsubscribe)
  }
  await useCanvas.getState().connectServer()
  expect(useCanvas.getState().connection).toBe('connected')
})

function approval(approvalId: string): ApprovalRequestParams {
  return {
    approvalId,
    runId: 'run_1',
    nodeId: 'value',
    path: 'value',
    request: { action: 'emit', target: 'x' },
  }
}

describe('approvals', () => {
  it('answers the entry with the requested id and leaves the rest queued', () => {
    const first = { params: approval('a1'), resolve: vi.fn() }
    const second = { params: approval('a2'), resolve: vi.fn() }
    const third = { params: approval('a3'), resolve: vi.fn() }
    useCanvas.setState({ approvals: [first, second, third] })

    useCanvas.getState().respondApproval('a2', 'allowed-once')

    expect(second.resolve).toHaveBeenCalledWith('allowed-once')
    expect(first.resolve).not.toHaveBeenCalled()
    expect(third.resolve).not.toHaveBeenCalled()
    expect(useCanvas.getState().approvals.map((entry) => entry.params.approvalId)).toEqual([
      'a1',
      'a3',
    ])
  })

  it('ignores an unknown id instead of consuming the head of the queue', () => {
    const head = { params: approval('a1'), resolve: vi.fn() }
    useCanvas.setState({ approvals: [head] })

    useCanvas.getState().respondApproval('missing', 'rejected')

    expect(head.resolve).not.toHaveBeenCalled()
    expect(useCanvas.getState().approvals).toHaveLength(1)
  })
})

describe('run notifications', () => {
  it('unregisters the socket handlers on disconnect', () => {
    expect(fake.onRunEvent).toHaveBeenCalledTimes(1)
    expect(fake.onRunStatus).toHaveBeenCalledTimes(1)
    useCanvas.getState().disconnect()
    for (const unsubscribe of fake.unsubscribes) expect(unsubscribe).toHaveBeenCalled()
    expect(useCanvas.getState().connection).toBe('idle')
  })

  it('folds a completed event into node status and outputs', () => {
    useCanvas.getState().ingestEvent({
      runId: 'run_1',
      seq: 2,
      event: { type: 'run.completed', runId: 'run_1', outputs: { text: 'hi' }, at: 1 },
    })
    useCanvas.getState().ingestStatus({ runId: 'run_1', status: 'completed' })

    expect(useCanvas.getState().runId).toBe('run_1')
    expect(useCanvas.getState().runStatus).toBe('completed')
    expect(useCanvas.getState().outputs).toEqual({ text: 'hi' })
  })

  it('tracks per-path node state, durations and prompt metadata', () => {
    const events: RunEvent[] = [
      { type: 'run.started', runId: 'run_1', graphId: 'g', graphDigest: 'd', at: 1 },
      { type: 'node.started', runId: 'run_1', nodeId: 'chat', path: 'chat', attempt: 1, at: 10 },
      {
        type: 'node.completed',
        runId: 'run_1',
        nodeId: 'chat',
        path: 'chat',
        attempt: 1,
        durationMs: 120,
        at: 130,
        outputs: { text: 'hi', hash: 'abc123def456789', tokens: 12 },
      },
      {
        type: 'node.started',
        runId: 'run_1',
        nodeId: 'chat',
        path: 'loop/0/chat',
        attempt: 1,
        at: 140,
      },
      {
        type: 'node.failed',
        runId: 'run_1',
        nodeId: 'chat',
        path: 'loop/0/chat',
        attempt: 1,
        error: 'boom',
        at: 150,
      },
    ]
    events.forEach((event, index) => {
      useCanvas.getState().ingestEvent({ runId: 'run_1', seq: index + 1, event })
    })

    const state = useCanvas.getState()
    const chat = state.nodeRun['chat']
    expect(chat?.status).toBe('completed')
    expect(chat?.startedAt).toBe(10)
    expect(chat?.durationMs).toBe(120)
    expect(chat?.outputs).toEqual({ text: 'hi', hash: 'abc123def456789', tokens: 12 })
    expect(chat?.promptHash).toBe('abc123def456789')
    expect(chat?.tokens).toBe(12)

    const nested = state.nodeRun['loop/0/chat']
    expect(nested?.status).toBe('failed')
    expect(nested?.error).toBe('boom')
    expect(nested?.startedAt).toBe(140)
    expect(state.runTimeline.map((entry) => entry.type)).toEqual([
      'node.started',
      'node.completed',
      'node.started',
      'node.failed',
    ])
    expect(nodeRunFor(state.nodeRun, 'chat')).toBe(chat)
    expect(nodeRunFor(state.nodeRun, 'loop')).toBe(nested)
  })

  it('clears the overlay when a new run starts', () => {
    useCanvas.setState({
      nodeRun: { chat: { status: 'failed', error: 'old' } },
      runTimeline: [{ seq: 1, type: 'node.failed', path: 'chat', at: 1 }],
      runDetail: { runId: 'run_old', record: {}, events: [] },
    })
    useCanvas.getState().ingestEvent({
      runId: 'run_1',
      seq: 2,
      event: { type: 'run.started', runId: 'run_1', graphId: 'g', graphDigest: 'd', at: 2 },
    })
    expect(useCanvas.getState().nodeRun).toEqual({})
    expect(useCanvas.getState().runTimeline).toEqual([])
    expect(useCanvas.getState().runDetail).toBeNull()
  })
})

describe('run selection', () => {
  const record: RunRecord = {
    runId: 'run_selected',
    graphId: 'hello',
    graphDigest: 'd',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
  }

  it('selectRun loads the run and exposes record plus events as runDetail', async () => {
    const events = [
      {
        seq: 1,
        event: {
          type: 'run.completed' as const,
          runId: 'run_selected',
          outputs: { text: 'hi' },
          at: 3,
        },
      },
    ]
    fake.runGet.mockResolvedValue({ record, events })

    await useCanvas.getState().selectRun('run_selected')

    expect(fake.runGet).toHaveBeenCalledWith('run_selected')
    const state = useCanvas.getState()
    expect(state.runDetail?.runId).toBe('run_selected')
    expect(state.runDetail?.record).toEqual(record)
    expect(state.runDetail?.events).toEqual(events)
    expect(state.selectedRun?.record.runId).toBe('run_selected')
    expect(state.outputs).toEqual({ text: 'hi' })
  })
})

describe('fork', () => {
  const record: RunRecord = {
    runId: 'run_parent',
    graphId: 'hello',
    graphDigest: 'd',
    status: 'completed',
    createdAt: 1,
    updatedAt: 2,
  }
  const selected: RunGetResult = { record, events: [] }

  it('resumes the forked run from the requested node path', async () => {
    useCanvas.setState({
      selectedRun: selected,
      forkInput: 'template',
      runInput: '{"name":"world"}',
      runStatus: 'completed',
      outputs: { text: 'stale' },
    })
    fake.runFork.mockResolvedValue({
      runId: 'run_fork',
      parentRunId: 'run_parent',
      forkSeq: 1,
    })

    await useCanvas.getState().forkRun()

    expect(fake.runFork).toHaveBeenCalledWith('run_parent', { nodePath: 'template' })
    expect(fake.runResume).toHaveBeenCalledTimes(1)
    const params = fake.runResume.mock.calls[0]?.[0] as unknown as {
      runId: string
      graph: { nodes: unknown[] }
      input?: unknown
    }
    expect(params.runId).toBe('run_fork')
    expect(params.graph.nodes).toEqual([])
    // The fork branch must still see the input the run was started with.
    expect(params.input).toEqual({ name: 'world' })

    const state = useCanvas.getState()
    expect(state.runId).toBe('run_fork')
    expect(state.outputs).toEqual({})
    expect(state.runError).toBeNull()
  })

  it('defaults to the selected node and reports a resume failure', async () => {
    useCanvas.setState({ selectedRun: selected, forkInput: '', selectedId: 'template' })
    fake.runFork.mockResolvedValue({
      runId: 'run_fork',
      parentRunId: 'run_parent',
      forkSeq: 1,
    })
    fake.runResume.mockRejectedValue(new Error('server went away'))

    await useCanvas.getState().forkRun()

    expect(fake.runFork).toHaveBeenCalledWith('run_parent', { nodePath: 'template' })
    expect(useCanvas.getState().runError).toBe('server went away')
    expect(useCanvas.getState().runStatus).toBe('failed')
  })

  it('forkAt branches at an explicit path and resumes the fork', async () => {
    useCanvas.setState({ selectedRun: selected, runStatus: 'completed', runInput: '' })
    fake.runFork.mockResolvedValue({
      runId: 'run_fork',
      parentRunId: 'run_parent',
      forkSeq: 2,
    })

    await useCanvas.getState().forkAt('loop/0/chat')

    expect(fake.runFork).toHaveBeenCalledWith('run_parent', { nodePath: 'loop/0/chat' })
    expect(fake.runResume).toHaveBeenCalledTimes(1)
    expect(useCanvas.getState().runId).toBe('run_fork')
  })
})


function descriptor(
  id: string,
  version = '1.0.0',
  defaultConfig: Json = {},
): NodeDescriptor {
  return { id, version, title: id, category: 'core', inputs: [], outputs: [], configSchema: {}, defaultConfig }
}

const descriptors: NodeDescriptor[] = [
  descriptor('z1.core.input', '1.0.0'),
  descriptor('z1.core.template', '1.0.0', { template: '' }),
  descriptor('z1.core.output', '1.0.0', { port: 'output' }),
]

const helloDocument: GraphDocument = {
  schemaVersion: 1,
  id: 'hello',
  title: 'Hello',
  nodes: [
    { id: 'input', type: 'z1.core.input', version: '1.0.0', config: {}, position: { x: 0, y: 0 } },
    {
      id: 'template',
      type: 'z1.core.template',
      version: '1.0.0',
      config: { template: 'hello {{name}}' },
      position: { x: 260, y: 0 },
    },
    {
      id: 'output',
      type: 'z1.core.output',
      version: '1.0.0',
      config: {},
      position: { x: 520, y: 0 },
    },
  ],
  edges: [
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
  ],
}

describe('server-backed graphs', () => {
  it('openGraph loads nodes and edges and adopts the stored version', async () => {
    fake.graphGet.mockResolvedValue({ graph: helloDocument, version: 4, updatedAt: 5 })
    useCanvas.setState({ descriptors, runId: 'stale-run', graphDirty: true })

    await useCanvas.getState().openGraph('hello')

    const state = useCanvas.getState()
    expect(fake.graphGet).toHaveBeenCalledWith('hello')
    expect(state.nodes.map((node) => node.id)).toEqual(['input', 'template', 'output'])
    expect(state.edges.map((edge) => edge.id)).toEqual([
      'e-in-vars',
      'e-template-value',
      'f-in-output',
    ])
    expect(state.edges[0]?.sourceHandle).toBe('input:value:data')
    expect(state.currentGraphId).toBe('hello')
    expect(state.graphVersion).toBe(4)
    expect(state.lastSavedAt).toBe(5)
    expect(state.graphDirty).toBe(false)
    expect(state.runId).toBeNull()
  })

  it('saveGraph sends the loaded version, then clears dirty and advances it', async () => {
    useCanvas.setState({ descriptors, currentGraphId: 'hello', graphVersion: 2, graphDirty: true })
    useCanvas.getState().newGraph('hello')
    // newGraph detaches the document; reattach the stored identity.
    useCanvas.setState({ currentGraphId: 'hello', graphVersion: 2 })
    fake.graphSave.mockResolvedValue({ id: 'hello', version: 3, updatedAt: 20 })

    await useCanvas.getState().saveGraph()

    expect(fake.graphSave).toHaveBeenCalledTimes(1)
    const params = fake.graphSave.mock.calls[0]?.[0] as unknown as {
      graph: GraphDocument
      expectedVersion: number
    }
    expect(params.expectedVersion).toBe(2)
    expect(params.graph.id).toBe('hello')
    expect(params.graph.nodes).toHaveLength(3)
    const state = useCanvas.getState()
    expect(state.graphVersion).toBe(3)
    expect(state.graphDirty).toBe(false)
    expect(state.lastSavedAt).toBe(20)
    expect(state.graphSaving).toBe(false)
    expect(fake.graphList).toHaveBeenCalled()
  })

  it('a conflict keeps the graph dirty and explains the reload', async () => {
    useCanvas.getState().newGraph('hello')
    useCanvas.setState({ currentGraphId: 'hello', graphVersion: 2, graphDirty: true })
    fake.graphSave.mockRejectedValue(new JsonRpcFault(APP_ERRORS.conflict, 'stale version'))

    await useCanvas.getState().saveGraph()

    const state = useCanvas.getState()
    expect(state.graphDirty).toBe(true)
    expect(state.graphSaving).toBe(false)
    expect(state.graphVersion).toBe(2)
    expect(state.lastSavedAt).toBeNull()
    expect(state.graphError).toBe('graph changed elsewhere — reload before saving')
  })

  it('newGraph("hello") builds the example graph from descriptor versions', () => {
    useCanvas.setState({
      descriptors: [
        descriptor('z1.core.input', '9.1.0'),
        descriptor('z1.core.template', '9.2.0'),
        descriptor('z1.core.output', '9.3.0'),
      ],
    })

    useCanvas.getState().newGraph('hello')

    const state = useCanvas.getState()
    expect(state.nodes.map((node) => node.id)).toEqual(['input', 'template', 'output'])
    expect(state.nodes.map((node) => node.data.descriptor.version)).toEqual([
      '9.1.0',
      '9.2.0',
      '9.3.0',
    ])
    expect(state.nodes.find((node) => node.id === 'template')?.data.config).toEqual({
      template: 'hello {{name}}',
    })
    expect(state.edges.map((edge) => edge.id)).toEqual([
      'e-in-vars',
      'e-template-value',
      'f-in-output',
    ])
    expect(state.currentGraphId).toBeNull()
    expect(state.graphDirty).toBe(true)
  })

  it('a palette add seals a deep copy of the descriptor defaultConfig', () => {
    const template = descriptor('test.template', '1.0.0', { template: 'x', nested: { a: 1 } })
    useCanvas.setState({ descriptors: [template], nodes: [], edges: [] })

    useCanvas.getState().addNode('test.template@1.0.0')

    const node = useCanvas.getState().nodes[0]
    expect(node?.data.config).toEqual({ template: 'x', nested: { a: 1 } })
    expect(node?.data.config).not.toBe(template.defaultConfig)
    // Nested objects are copied too: mutating the node must not reach back.
    const config = node?.data.config as unknown as { nested: { a: number } }
    config.nested.a = 2
    expect(template.defaultConfig).toEqual({ template: 'x', nested: { a: 1 } })
    useCanvas.getState().updateConfig('test-template-1', { template: 'changed' })
    expect(template.defaultConfig).toEqual({ template: 'x', nested: { a: 1 } })
  })
})
