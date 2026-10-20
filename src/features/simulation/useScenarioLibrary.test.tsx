import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useScenarioLibrary } from './useScenarioLibrary'
import { FakeScenarioRepository } from './tests/fakeScenarioRepository'
import type { SimulationDraft } from './draft'

/**
 * Hook-level contracts for the saved-scenario workflow (phase 45.1):
 * record identity after Save As, and the initial list lifecycle.
 */

const draftWith = (clearance: string): SimulationDraft => ({
  startTime: '0',
  endTime: '24',
  outputInterval: '0.25',
  centralVolume: { value: '10', unit: 'L' },
  peripheralVolume: { value: '20', unit: 'L' },
  clearance: { value: clearance, unit: 'L/h' },
  intercompartmentalClearance: { value: '3', unit: 'L/h' },
  initialCentralAmount: '0',
  initialPeripheralAmount: '0',
  events: [],
  solver: {
    absoluteTolerance: '1e-10',
    relativeTolerance: '1e-10',
    initialStep: '0.01',
    minStep: '1e-12',
    maxStep: '0.25',
    maxSteps: '200000',
  },
})

let repository: FakeScenarioRepository

beforeEach(() => {
  repository = new FakeScenarioRepository()
})

describe('useScenarioLibrary — Save As identity', () => {
  it('adopts the exact id returned by create, even when other records share the name', async () => {
    // Same-name records exist FIRST and are given LATER timestamps than the
    // record Save As creates, so a newest-first name lookup would resolve to
    // one of them. Only the id returned by create() is correct here.
    repository.seed('Shared name', draftWith('1'))
    repository.seed('Shared name', draftWith('2'))
    const future = new Date(Date.UTC(2030, 0, 1)).toISOString()
    repository.touch('saved-2', future)

    const { result } = renderHook(() => useScenarioLibrary(repository))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      await result.current.saveAs('Shared name', draftWith('7'))
    })
    // saved-1 and saved-2 predate the save and sort AHEAD of saved-3.
    expect(repository.size).toBe(3)
    expect(result.current.loadedId).toBe('saved-3')
    expect(result.current.summaries[0]?.id).not.toBe('saved-3')

    await act(async () => {
      const ok = await result.current.saveOverCurrent(draftWith('8'))
      expect(ok).toBe(true)
    })
    expect(repository.getRecord('saved-3')?.draft.clearance.value).toBe('8')
    expect(repository.getRecord('saved-1')?.draft.clearance.value).toBe('1')
    expect(repository.getRecord('saved-2')?.draft.clearance.value).toBe('2')
  })
  it('keeps the identity when timestamps tie and list order cannot help', async () => {
    const fixed = new Date(Date.UTC(2026, 0, 1)).toISOString()
    repository.seedAt('Shared name', draftWith('1'), fixed)
    repository.seedAt('Shared name', draftWith('2'), fixed)

    const { result } = renderHook(() => useScenarioLibrary(repository))
    await waitFor(() => expect(result.current.status).toBe('ready'))

    await act(async () => {
      await result.current.saveAs('Shared name', draftWith('9'))
    })
    expect(result.current.loadedId).toBe('saved-3')

    // Saving over updates ONLY that record; same-name records stay intact.
    await act(async () => {
      await result.current.saveOverCurrent(draftWith('11'))
    })
    expect(repository.getRecord('saved-3')?.draft.clearance.value).toBe('11')
    expect(repository.getRecord('saved-1')?.draft.clearance.value).toBe('1')
    expect(repository.getRecord('saved-2')?.draft.clearance.value).toBe('2')
  })

  it('reports the failure and keeps no identity when create fails', async () => {
    const { result } = renderHook(() => useScenarioLibrary(repository))
    await waitFor(() => expect(result.current.status).toBe('ready'))
    repository.failNext = 'storage'

    let ok = true
    await act(async () => {
      ok = await result.current.saveAs('Will fail', draftWith('5'))
    })
    expect(ok).toBe(false)
    expect(result.current.loadedId).toBeNull()
    expect(result.current.feedback?.kind).toBe('error')
    expect(repository.size).toBe(0)
  })
})

describe('useScenarioLibrary — initial list lifecycle', () => {
  it('starts in loading, then shows an empty library after the read resolves', async () => {
    const { result } = renderHook(() => useScenarioLibrary(repository))
    // Before the first read resolves the library is unknown, not empty.
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.summaries).toEqual([])
  })

  it('starts in loading, then reports a read failure', async () => {
    repository.failList = true
    const { result } = renderHook(() => useScenarioLibrary(repository))
    expect(result.current.status).toBe('loading')
    await waitFor(() => expect(result.current.status).toBe('error'))
    expect(result.current.feedback?.kind).toBe('error')
  })

  it('reports loading until a DELAYED initial read resolves', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const list = repository.list.bind(repository)
    repository.list = async () => {
      await gate
      return list()
    }
    repository.seed('Delayed', draftWith('3'))

    const { result } = renderHook(() => useScenarioLibrary(repository))
    await act(async () => {
      await Promise.resolve()
    })
    // Still inside the initial read: loading, and definitively not "empty".
    expect(result.current.status).toBe('loading')
    expect(result.current.summaries).toEqual([])

    await act(async () => {
      release()
      await gate
    })
    await waitFor(() => expect(result.current.status).toBe('ready'))
    expect(result.current.summaries.map((row) => row.name)).toEqual(['Delayed'])
  })
})