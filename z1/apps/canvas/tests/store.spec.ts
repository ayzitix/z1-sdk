import type { RunRecord } from '@z1/journal'
import type { ApprovalRequestParams, RunGetResult } from '@z1/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
  runCancel: ReturnType<typeof vi.fn>
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
  runCancel: vi.fn(async () => ({})),
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
    fake.close,
  ]) {
    method.mockClear()
  }
  fake.runList.mockResolvedValue([])
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
    approvals: [],
    runs: [],
    selectedRun: null,
    forkInput: '',
    runInput: '',
    runsOpen: false,
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
    }
    expect(params.runId).toBe('run_fork')
    expect(params.graph.nodes).toEqual([])

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
})

