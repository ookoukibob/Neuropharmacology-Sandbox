import { describe, expect, it } from 'vitest'
import { parseMathNotation } from '@/components/scientific/notation'
import { SIMULATION_FIELDS, fieldSubject, simulationFieldForEngineSymbol } from './parameterFields'

/**
 * The metadata is the single place a parameter's readable name is written
 * down, so it is also the one place where a regression would silently affect
 * both the form and the error summary. These tests pin the split between the
 * machine identifier and the two kinds of human text.
 */
const notationTokens = (value: string): readonly string[] =>
  parseMathNotation(value)
    .filter((token) => token.kind !== 'text')
    .map((token) => `${token.kind}:${token.value}`)

describe('SIMULATION_FIELDS', () => {
  it('keeps every prose label free of notation', () => {
    for (const [id, definition] of Object.entries(SIMULATION_FIELDS)) {
      expect(definition.id, `${id} must keep its own id`).toBe(id)
      expect(notationTokens(definition.label), `label of ${id}: "${definition.label}"`).toEqual([])
    }
  })

  it('puts the notation only in `symbol`, and only for symbols that need it', () => {
    expect(SIMULATION_FIELDS.centralVolume.symbol).toBe('V_c')
    expect(SIMULATION_FIELDS.peripheralVolume.symbol).toBe('V_p')
    expect(SIMULATION_FIELDS.initialCentralAmount.symbol).toBe('A_c(0)')
    expect(SIMULATION_FIELDS.initialPeripheralAmount.symbol).toBe('A_p(0)')

    // Fields without a scientific symbol stay undefined rather than "".
    expect(SIMULATION_FIELDS.startTime.symbol).toBeUndefined()
    expect(SIMULATION_FIELDS['effectSite.molecularWeight'].symbol).toBeUndefined()
  })

  it('resolves an engine parameter symbol to the same definition the editor uses', () => {
    expect(simulationFieldForEngineSymbol('Vc')?.id).toBe('centralVolume')
    expect(simulationFieldForEngineSymbol('Vp')?.id).toBe('peripheralVolume')
    expect(simulationFieldForEngineSymbol('CL')?.id).toBe('clearance')
    expect(simulationFieldForEngineSymbol('Q')?.id).toBe('intercompartmentalClearance')
    expect(simulationFieldForEngineSymbol('not-a-symbol')).toBeUndefined()
  })
})

describe('fieldSubject', () => {
  it('returns the shared definition for a static field path', () => {
    const subject = fieldSubject('initialCentralAmount')
    expect(subject.definition?.id).toBe('initialCentralAmount')
    expect(subject.label).toBe('Initial central amount (mg — fixed canonical unit)')
    expect(subject.symbol).toBe('A_c(0)')
  })

  it('describes a dosing-row field in prose, without inventing notation', () => {
    expect(fieldSubject('events.2.stopTime').label).toBe('Dosing row 2: stop time')
    expect(fieldSubject('events.2.amount.value').label).toBe('Dosing row 2: amount')
    expect(fieldSubject('events.11.rate.value').label).toBe('Dosing row 11: rate')
    expect(fieldSubject('events.2.stopTime').symbol).toBeUndefined()
  })

  it('keeps an unknown path visible instead of dropping it from the summary', () => {
    expect(fieldSubject('some.future.field').label).toBe('some.future.field')
  })
})
