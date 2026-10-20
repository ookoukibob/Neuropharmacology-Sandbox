import { describe, expect, it } from 'vitest'
import { simulate } from '@/engine/simulation/simulate'
import { DEMO_SCENARIO } from './demoScenario'
import {
  bolusEventId,
  compileScenario,
  demoDraft,
  draftFromScenario,
  infusionIdOf,
  infusionStartEventId,
  infusionStopEventId,
  newBolusRow,
  newInfusionRow,
  nextRowKey,
  type BolusRow,
  type SimulationDraft,
} from './draft'

/** Draft → scenario compilation: parsing, stability, immutability, mapping. */

const draft = (patch: Partial<SimulationDraft> = {}): SimulationDraft => ({ ...demoDraft(), ...patch })

const withEvents = (events: SimulationDraft['events']): SimulationDraft => draft({ events })

const ok = (value: ReturnType<typeof compileScenario>) => {
  if (!value.ok) throw new Error('expected a compiled scenario: ' + JSON.stringify(value.errors))
  return value.scenario
}

describe('draftFromScenario — the example round trip', () => {
  it('folds the paired infusion events back into one session row', () => {
    const draftValue = draftFromScenario(DEMO_SCENARIO)
    expect(draftValue.events.map((row) => row.kind)).toEqual(['bolus', 'bolus', 'infusion'])
    const infusion = draftValue.events[2]
    expect(infusion).toMatchObject({ kind: 'infusion', startTime: '2', stopTime: '6' })
    expect(infusion?.kind === 'infusion' ? infusion.rate : null).toEqual({ value: '10', unit: 'mg/h' })
  })

  it('compiles back to the same scientific scenario', () => {
    const scenario = ok(compileScenario(draftFromScenario(DEMO_SCENARIO)))
    expect(scenario.startTime).toBe(DEMO_SCENARIO.startTime)
    expect(scenario.endTime).toBe(DEMO_SCENARIO.endTime)
    expect(scenario.outputTimes).toEqual(DEMO_SCENARIO.outputTimes)
    expect(scenario.initialState).toEqual(DEMO_SCENARIO.initialState)
    expect(scenario.parameters).toEqual(DEMO_SCENARIO.parameters)
    expect(scenario.solver).toEqual(DEMO_SCENARIO.solver)
    // Event order is the engine's (stop, bolus, start within one time), so
    // compare the applied effect rather than array positions.
    const report = simulate(scenario)
    expect(report.ok).toBe(true)
  })

  it('never mutates the source scenario or returns a shared draft', () => {
    const before = JSON.stringify(DEMO_SCENARIO)
    const a = demoDraft()
    const b = demoDraft()
    expect(JSON.stringify(DEMO_SCENARIO)).toBe(before)
    expect(a).not.toBe(b)
    expect(a.events).not.toBe(b.events)
  })
})

describe('compileScenario — parsing', () => {
  it('leaves blank values blank (no silent zero) and reports them', () => {
    const result = compileScenario(draft({ clearance: { value: '', unit: 'L/h' } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((error) => error.field)).toContain('clearance')
    expect(result.errors.find((e) => e.field === 'clearance')?.code).toBe('REQUIRED')
  })

  it('rejects unparseable text and keeps the raw value in the message', () => {
    const result = compileScenario(draft({ peripheralVolume: { value: 'ten', unit: 'L' } }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors[0]?.code).toBe('NOT_A_NUMBER')
    expect(result.errors[0]?.message).toContain('ten')
  })

  it('passes declared units through unchanged instead of converting them', () => {
    const scenario = ok(
      compileScenario(
        draft({
          centralVolume: { value: '10000', unit: 'mL' },
          clearance: { value: '2000', unit: 'mL/h' },
        }),
      ),
    )
    expect(scenario.parameters.centralVolume).toEqual({ value: 10000, unit: 'mL' })
    expect(scenario.parameters.clearance).toEqual({ value: 2000, unit: 'mL/h' })
    // The engine performs the boundary conversion.
    const report = simulate(scenario)
    expect(report.ok).toBe(true)
    if (report.ok) expect(report.result.parameters[0]?.canonicalValue).toBe(10)
  })

  it('keeps the initial amounts as plain canonical mg numbers', () => {
    const scenario = ok(compileScenario(draft({ initialCentralAmount: '5', initialPeripheralAmount: '2.5' })))
    expect(scenario.initialState).toEqual({ centralAmount: 5, peripheralAmount: 2.5 })
  })

  it('builds the output grid from start, end and interval', () => {
    const scenario = ok(compileScenario(draft({ startTime: '1', endTime: '4', outputInterval: '1.5' })))
    expect(scenario.outputTimes).toEqual([1, 2.5, 4])
  })

  it('reports an invalid horizon once, on the end-time field', () => {
    const result = compileScenario(draft({ startTime: '10', endTime: '2' }))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.errors.map((e) => e.field)).toContain('endTime')
    expect(result.gridError?.ok).toBe(false)
  })

  it('does not mutate the draft it compiles', () => {
    const value = draft()
    const snapshot = JSON.stringify(value)
    compileScenario(value)
    expect(JSON.stringify(value)).toBe(snapshot)
  })
})

describe('compileScenario — dosing events', () => {
  it('maps one infusion row to a start and a stop event with a shared id', () => {
    const row = { kind: 'infusion' as const, key: 7, startTime: '2', stopTime: '5', rate: { value: '4', unit: 'µg/min' } }
    const scenario = ok(compileScenario(withEvents([row])))
    expect(scenario.events).toHaveLength(2)
    expect(scenario.events[0]).toEqual({
      type: 'infusion-start',
      eventId: infusionStartEventId(7),
      infusionId: infusionIdOf(7),
      time: 2,
      rate: { value: 4, unit: 'µg/min' },
    })
    expect(scenario.events[1]).toEqual({
      type: 'infusion-stop',
      eventId: infusionStopEventId(7),
      infusionId: infusionIdOf(7),
      time: 5,
    })
  })

  it('maps bolus rows to iv-bolus events with stable ids', () => {
    const row: BolusRow = { kind: 'bolus', key: 3, time: '1.5', amount: { value: '12', unit: 'g' } }
    const scenario = ok(compileScenario(withEvents([row])))
    expect(scenario.events).toEqual([
      { type: 'iv-bolus', eventId: bolusEventId(3), time: 1.5, amount: { value: 12, unit: 'g' } },
    ])
  })

  it('keeps several events at one timestamp', () => {
    const scenario = ok(
      compileScenario(
        withEvents([
          { kind: 'bolus', key: 1, time: '2', amount: { value: '1', unit: 'mg' } },
          { kind: 'bolus', key: 2, time: '2', amount: { value: '2', unit: 'mg' } },
          { kind: 'infusion', key: 3, startTime: '2', stopTime: '4', rate: { value: '3', unit: 'mg/h' } },
        ]),
      ),
    )
    expect(scenario.events.filter((event) => event.time === 2)).toHaveLength(3)
  })

  it('assigns unique, deterministic keys and never reuses the key of a removed row', () => {
    const d = demoDraft()
    const bolus = newBolusRow(d.events)
    expect(bolus.key).toBe(nextRowKey(d.events))
    // Keys are derived from the rows that remain, so a removed row's key is
    // free again — no stale row state can exist for a key that is not in the
    // list, and the new key never collides with a surviving row.
    const removed = d.events.filter((row) => row.key !== 3)
    const infusion = newInfusionRow(removed)
    expect(infusion.key).toBe(3)
    expect(removed.some((row) => row.key === infusion.key)).toBe(false)
    expect(new Set([...removed.map((r) => r.key), infusion.key]).size).toBe(removed.length + 1)
  })

  it('keeps editing one row isolated from the others', () => {
    const d = demoDraft()
    const updated = d.events.map((row) => (row.key === 2 && row.kind === 'bolus' ? { ...row, time: '9' } : row))
    const scenario = ok(compileScenario({ ...d, events: updated }))
    const boluses = scenario.events.filter((event) => event.type === 'iv-bolus')
    expect(boluses[0]?.time).toBe(0)
    expect(boluses[1]?.time).toBe(9)
    expect(boluses).toHaveLength(2)
  })

  it('starts new rows blank so clicking Add never invents a dose', () => {
    const d = demoDraft()
    const scenario = compileScenario({ ...d, events: [...d.events, newBolusRow(d.events)] })
    expect(scenario.ok).toBe(false)
    if (scenario.ok) return
    expect(scenario.errors.some((error) => error.code === 'REQUIRED')).toBe(true)
  })

  it('rejects an infusion whose stop is not after its start, naming the row', () => {
    const result = compileScenario(
      withEvents([{ kind: 'infusion', key: 5, startTime: '6', stopTime: '2', rate: { value: '1', unit: 'mg/h' } }]),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    const error = result.errors.find((e) => e.field === 'events.5.stopTime')
    expect(error?.message).toContain('later than its start time')
  })

  it('leaves event sequencing outside the horizon to the engine', () => {
    // In-horizon parse, out-of-horizon time: the UI compiles it and the
    // engine reports OUT_OF_RANGE with the event id.
    const scenario = ok(
      compileScenario(withEvents([{ kind: 'bolus', key: 1, time: '99', amount: { value: '1', unit: 'mg' } }])),
    )
    const report = simulate(scenario)
    expect(report.ok).toBe(false)
    if (report.ok) return
    expect(report.errors[0]?.code).toBe('OUT_OF_RANGE')
    expect(report.errors[0]?.eventId).toBe(bolusEventId(1))
  })

  it('leaves unsupported units to the engine', () => {
    const scenario = ok(
      compileScenario(withEvents([{ kind: 'bolus', key: 1, time: '1', amount: { value: '1', unit: 'L' } }])),
    )
    const report = simulate(scenario)
    expect(report.ok).toBe(false)
    if (report.ok) return
    expect(report.errors[0]?.code).toBe('INCOMPATIBLE_UNITS')
  })

  it('resolves back to the same trajectory as the example when unchanged', () => {
    const fromDraft = simulate(ok(compileScenario(demoDraft())))
    const fromExample = simulate(DEMO_SCENARIO)
    expect(fromDraft.ok).toBe(true)
    expect(fromExample.ok).toBe(true)
    if (!fromDraft.ok || !fromExample.ok) return
    expect(fromDraft.result.samples.map((s) => s.centralAmount)).toEqual(
      fromExample.result.samples.map((s) => s.centralAmount),
    )
  })
})
