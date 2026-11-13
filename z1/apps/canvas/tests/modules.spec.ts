import type { ModuleSummary, ProposalSummary } from '@z1/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const NODE_ID = 'com.example.echo.echo'

const proposal: ProposalSummary = {
  moduleId: 'com.example.echo',
  version: '1.0.0',
  title: 'Echo example module',
  integrity: 'a'.repeat(64),
  capabilities: { fs: { read: ['${moduleDir}/**'] } },
  directory: '/tmp/modules/proposals/com.example.echo@1.0.0',
}

const installed: ModuleSummary = {
  moduleId: 'com.example.echo',
  version: '1.0.0',
  title: 'Echo example module',
  integrity: proposal.integrity,
  active: true,
  capabilities: proposal.capabilities,
  nodes: [
    {
      id: NODE_ID,
      title: 'Echo',
      category: 'example',
      inputs: 1,
      outputs: 2,
    },
  ],
}

const fake = {
  onClose: vi.fn(),
  onRunEvent: vi.fn(),
  onRunStatus: vi.fn(),
  onApprovalRequest: vi.fn(),
  initialize: vi.fn(async () => ({
    serverName: 'z1' as const,
    protocolVersion: '1' as const,
    capabilities: { runs: true, approvals: true, modules: true },
  })),
  nodeList: vi.fn(),
  runList: vi.fn(async () => []),
  graphValidate: vi.fn(),
  runStart: vi.fn(),
  runFork: vi.fn(),
  runResume: vi.fn(),
  runCancel: vi.fn(),
  moduleList: vi.fn(),
  graphList: vi.fn(async () => ({ graphs: [] })),
  modulePropose: vi.fn(async () => proposal),
  moduleApprove: vi.fn(async () => installed),
  moduleRollback: vi.fn(async () => installed),
  moduleAudit: vi.fn(async () => []),
  close: vi.fn(),
  unsubscribes: [] as Array<ReturnType<typeof vi.fn>>,
}

vi.mock('../src/api.ts', () => ({
  CanvasClient: { connect: async () => fake },
  errorText: (error: unknown) => (error instanceof Error ? error.message : String(error)),
}))

const { useCanvas } = await import('../src/store.ts')

beforeEach(async () => {
  for (const unsubscribe of fake.unsubscribes.splice(0)) unsubscribe()
  for (const method of [
    fake.onClose,
    fake.onRunEvent,
    fake.onRunStatus,
    fake.onApprovalRequest,
    fake.initialize,
    fake.nodeList,
    fake.runList,
    fake.moduleList,
    fake.graphList,
    fake.modulePropose,
    fake.moduleApprove,
    fake.moduleRollback,
    fake.moduleAudit,
    fake.close,
  ]) {
    method.mockClear()
  }
  for (const method of [fake.onClose, fake.onRunEvent, fake.onRunStatus, fake.onApprovalRequest]) {
    const unsubscribe = vi.fn()
    fake.unsubscribes.push(unsubscribe)
    method.mockImplementation(() => unsubscribe)
  }
  fake.runList.mockResolvedValue([])
  fake.nodeList.mockResolvedValue([])
  fake.moduleList.mockResolvedValue({ modules: [], proposals: [proposal] })
  fake.graphList.mockResolvedValue({ graphs: [] })
  fake.moduleAudit.mockResolvedValue([])

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
    modules: [],
    proposals: [],
    moduleAudit: [],
    moduleError: null,
    modulesOpen: false,
  })
  await useCanvas.getState().connectServer()
  expect(useCanvas.getState().connection).toBe('connected')
})

describe('modules', () => {
  it('loads proposals on connect', () => {
    expect(fake.moduleList).toHaveBeenCalledTimes(1)
    expect(useCanvas.getState().modules).toEqual([])
    expect(useCanvas.getState().proposals).toEqual([proposal])
  })

  it('approving refreshes modules and node descriptors', async () => {
    fake.moduleList.mockResolvedValue({ modules: [installed], proposals: [] })
    fake.nodeList.mockResolvedValue([
      {
        id: NODE_ID,
        version: '1.0.0',
        title: 'Echo',
        category: 'example',
        inputs: [],
        outputs: [],
      },
    ])

    await useCanvas.getState().approveModule('com.example.echo', '1.0.0')

    expect(fake.moduleApprove).toHaveBeenCalledWith('com.example.echo', '1.0.0')
    expect(fake.moduleList).toHaveBeenCalledTimes(2)
    expect(fake.nodeList).toHaveBeenCalledTimes(2)
    expect(useCanvas.getState().modules).toEqual([installed])
    expect(useCanvas.getState().proposals).toEqual([])
    expect(useCanvas.getState().descriptors.map((descriptor) => descriptor.id)).toEqual([NODE_ID])
    expect(useCanvas.getState().moduleError).toBeNull()
  })

  it('a rejected approval keeps the error and leaves state alone', async () => {
    fake.moduleApprove.mockRejectedValueOnce(new Error('no proposal for "com.example.echo"@9.9.9'))

    await useCanvas.getState().approveModule('com.example.echo', '9.9.9')

    expect(useCanvas.getState().moduleError).toContain('9.9.9')
    expect(useCanvas.getState().modules).toEqual([])
  })
})
