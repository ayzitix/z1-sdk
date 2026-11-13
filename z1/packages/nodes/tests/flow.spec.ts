import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import { defineNode } from '@z1/node'
import { dataPort, inputValues, isRecord } from '../src/shared.ts'
import { dataEdge, flowEdge, graphNode, makeGraph, runBuiltins } from './helpers.ts'

/** Test-only body node: reports `done` once enough iterations have run. */
const bodyDone = defineNode({
  id: 'test.body.done',
  version: '1.0.0',
  title: 'Body done',
  category: 'test',
  config: z.object({}),
  inputs: [dataPort('state', z.unknown())],
  outputs: [dataPort('done', z.boolean())],
  execute: async (ctx) => {
    // Non-root nodes see a port-keyed record, so the body state is under `state`.
    const state = inputValues(ctx.input)['state']
    const iteration = isRecord(state) ? state['iteration'] : undefined
    return { done: typeof iteration === 'number' && iteration >= 2 }
  },
})

function branchGraph(condition: boolean) {
  return makeGraph(
    `if-${String(condition)}`,
    [
      graphNode('start', 'z1.core.input'),
      graphNode('cond', 'z1.core.const', { value: condition }),
      graphNode('branch', 'z1.flow.if'),
      graphNode('valThen', 'z1.core.const', { value: 'T' }),
      graphNode('valElse', 'z1.core.const', { value: 'E' }),
      graphNode('outThen', 'z1.core.output', { port: 'then' }),
      graphNode('outElse', 'z1.core.output', { port: 'else' }),
    ],
    [
      flowEdge('f1', 'start', 'out', 'branch', 'in'),
      dataEdge('d1', 'cond', 'value', 'branch', 'condition'),
      flowEdge('f2', 'branch', 'then', 'outThen', 'in'),
      flowEdge('f3', 'branch', 'else', 'outElse', 'in'),
      dataEdge('d2', 'valThen', 'value', 'outThen', 'value'),
      dataEdge('d3', 'valElse', 'value', 'outElse', 'value'),
    ],
  )
}

describe('z1.flow.if', () => {
  test('runs the then branch', async () => {
    const { result } = await runBuiltins({ graph: branchGraph(true), input: {} })
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ then: 'T' })
  })

  test('runs the else branch', async () => {
    const { result } = await runBuiltins({ graph: branchGraph(false), input: {} })
    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ else: 'E' })
  })
})

describe('z1.flow.loop', () => {
  const body = makeGraph(
    'loop-body',
    [
      graphNode('bin', 'z1.core.input'),
      graphNode('tpl', 'z1.core.template', { template: '{{value}}!' }),
      graphNode('done', 'test.body.done'),
      graphNode('outValue', 'z1.core.output', { port: 'value' }),
      graphNode('outDone', 'z1.core.output', { port: 'done' }),
    ],
    [
      dataEdge('b1', 'bin', 'value', 'tpl', 'vars'),
      dataEdge('b2', 'tpl', 'text', 'outValue', 'value'),
      dataEdge('b3', 'bin', 'value', 'done', 'state'),
      dataEdge('b4', 'done', 'done', 'outDone', 'value'),
    ],
  )

  test('feeds the body result back until it reports done', async () => {
    const graph = makeGraph(
      'loop',
      [
        graphNode('start', 'z1.core.input'),
        graphNode('seed', 'z1.core.const', { value: 'x' }),
        graphNode('loop1', 'z1.flow.loop', { body, maxIterations: 10 }),
        graphNode('outResult', 'z1.core.output', { port: 'result' }),
        graphNode('outCount', 'z1.core.output', { port: 'iterations' }),
      ],
      [
        flowEdge('f1', 'start', 'out', 'loop1', 'in'),
        dataEdge('d1', 'seed', 'value', 'loop1', 'seed'),
        dataEdge('d2', 'loop1', 'result', 'outResult', 'value'),
        dataEdge('d3', 'loop1', 'iterations', 'outCount', 'value'),
      ],
    )

    const { result, events } = await runBuiltins({ graph, input: null, definitions: [bodyDone] })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ result: 'x!!!', iterations: 3 })
    // Each iteration owns a distinct path segment, so the journal can tell them
    // apart on resume.
    const startedPaths = events
      .filter((event) => event.type === 'node.started')
      .map((event) => event.path)
    expect(startedPaths).toContain('loop1/0/tpl')
    expect(startedPaths).toContain('loop1/1/tpl')
    expect(startedPaths).toContain('loop1/2/tpl')
    expect(startedPaths).not.toContain('loop1/tpl')
  })

  test('a body without a done port runs exactly maxIterations with an absent seed', async () => {
    // No `done` output at all: the loop must stop on the cap, and a missing
    // seed must behave as JSON null on the first iteration.
    const noDoneBody = makeGraph(
      'loop-body-no-done',
      [
        graphNode('bin', 'z1.core.input'),
        graphNode('tpl', 'z1.core.template', { template: '{{value}}!' }),
        graphNode('outValue', 'z1.core.output', { port: 'value' }),
      ],
      [
        dataEdge('b1', 'bin', 'value', 'tpl', 'vars'),
        dataEdge('b2', 'tpl', 'text', 'outValue', 'value'),
      ],
    )
    const graph = makeGraph(
      'loop-no-done',
      [
        graphNode('start', 'z1.core.input'),
        graphNode('loop1', 'z1.flow.loop', { body: noDoneBody, maxIterations: 2 }),
        graphNode('outResult', 'z1.core.output', { port: 'result' }),
        graphNode('outCount', 'z1.core.output', { port: 'iterations' }),
      ],
      [
        flowEdge('f1', 'start', 'out', 'loop1', 'in'),
        dataEdge('d2', 'loop1', 'result', 'outResult', 'value'),
        dataEdge('d3', 'loop1', 'iterations', 'outCount', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph, input: null })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ result: 'null!!', iterations: 2 })
  })
})

describe('z1.flow.map', () => {
  const body = makeGraph(
    'map-body',
    [
      graphNode('bin', 'z1.core.input'),
      graphNode('tpl', 'z1.core.template', { template: '{{item}}*' }),
      graphNode('out1', 'z1.core.output', { port: 'value' }),
    ],
    [
      dataEdge('b1', 'bin', 'value', 'tpl', 'vars'),
      dataEdge('b2', 'tpl', 'text', 'out1', 'value'),
    ],
  )

  test('runs the body once per item and preserves order', async () => {
    const graph = makeGraph(
      'map',
      [
        graphNode('items', 'z1.core.const', { value: [1, 2, 3] }),
        graphNode('map1', 'z1.flow.map', { body }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'items', 'value', 'map1', 'items'),
        dataEdge('d2', 'map1', 'results', 'out1', 'value'),
      ],
    )

    const { result, events } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: ['1*', '2*', '3*'] })
    const startedPaths = events
      .filter((event) => event.type === 'node.started')
      .map((event) => event.path)
    expect(startedPaths).toContain('map1/0/tpl')
    expect(startedPaths).toContain('map1/2/tpl')
  })

  test('an empty array produces an empty result list', async () => {
    const graph = makeGraph(
      'map-empty',
      [
        graphNode('items', 'z1.core.const', { value: [] }),
        graphNode('map1', 'z1.flow.map', { body }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'items', 'value', 'map1', 'items'),
        dataEdge('d2', 'map1', 'results', 'out1', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: [] })
  })

  test('exposes index alongside item in the body input', async () => {
    const indexedBody = makeGraph(
      'map-body-index',
      [
        graphNode('bin', 'z1.core.input'),
        graphNode('tpl', 'z1.core.template', { template: '{{index}}:{{item}}' }),
        graphNode('out1', 'z1.core.output', { port: 'value' }),
      ],
      [
        dataEdge('b1', 'bin', 'value', 'tpl', 'vars'),
        dataEdge('b2', 'tpl', 'text', 'out1', 'value'),
      ],
    )
    const graph = makeGraph(
      'map-index',
      [
        graphNode('items', 'z1.core.const', { value: ['a', 'b'] }),
        graphNode('map1', 'z1.flow.map', { body: indexedBody }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'items', 'value', 'map1', 'items'),
        dataEdge('d2', 'map1', 'results', 'out1', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('completed')
    expect(result.outputs).toEqual({ output: ['0:a', '1:b'] })
  })

  test('fails clearly when the item count exceeds maxItems', async () => {
    const graph = makeGraph(
      'map-cap',
      [
        graphNode('items', 'z1.core.const', { value: [1, 2, 3] }),
        graphNode('map1', 'z1.flow.map', { body, maxItems: 2 }),
        graphNode('out1', 'z1.core.output'),
      ],
      [
        dataEdge('d1', 'items', 'value', 'map1', 'items'),
        dataEdge('d2', 'map1', 'results', 'out1', 'value'),
      ],
    )

    const { result } = await runBuiltins({ graph })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('3 items exceed maxItems 2')
  })
})
