/**
 * Persistence DTO mapper tests (ADR-14): round-trip identity, validation,
 * quarantine-able failures, and unknown-field preservation across edits.
 */
import { describe, expect, it } from 'vitest'
import { FIXTURE_NOTE, syntheticDrug } from '../../tests/fixtures'
import { fieldAt } from '../../tests/runtimeFields'
import type { Drug } from '../../domain/drug/drug'
import {
  PERSISTENCE_VERSION,
  fromRecord,
  preserveUnknownFields,
  toRecord,
  toStoredRecord,
  type DrugRecord,
} from './records'

function drugOf(raw: unknown) {
  const result = fromRecord(raw)
  if (!result.ok) throw new Error(`expected valid record, got: ${result.errors.join('; ')}`)
  return result.drug
}

describe('toRecord / fromRecord — round trip', () => {
  it('maps a domain drug to a record and back without loss', () => {
    const drug = syntheticDrug()
    const record = toRecord(drug)
    expect(record.persistenceVersion).toBe(PERSISTENCE_VERSION)
    const back = drugOf(record)
    expect(back).toEqual(drug)
  })

  it('keeps provenance triples whole — never flattened to bare numbers', () => {
    const record = toRecord(syntheticDrug())
    const kd = record.targets[0]?.kd
    expect(kd).toEqual({
      value: 12.4,
      unit: 'nM',
      provenance: {
        type: 'literature',
        source: 'Synthetic fixture source',
        citation: 'Invented for tests, 2026',
      },
    })
    expect(kd && 'provenance' in kd).toBe(true)
  })

  it('omits absent optionals instead of writing undefined', () => {
    const { notes: _cleared, ...withoutNotes } = syntheticDrug()
    const record = toRecord(withoutNotes)
    expect('notes' in record).toBe(false)
    expect('description' in record.identifiers).toBe(true) // fixture declares one
    const bare = toRecord({
      ...syntheticDrug(),
      identifiers: { name: 'X', synonyms: [] },
    })
    expect('description' in bare.identifiers).toBe(false)
    expect('casNumber' in bare.identifiers).toBe(false)
  })

  it('applies the documented array defaults on read (missing tags/targets -> [])', () => {
    const drug = syntheticDrug()
    const record = toRecord(drug) as unknown as Record<string, unknown>
    delete record['tags']
    delete record['targets']
    const back = drugOf(record)
    expect(back.tags).toEqual([])
    expect(back.targets).toEqual([])
  })
})

describe('fromRecord — validation and quarantine', () => {
  it('rejects an unknown origin with a path-qualified message', () => {
    const result = fromRecord({ ...toRecord(syntheticDrug()), origin: 'bogus' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('origin')
  })

  it('rejects a record without a name', () => {
    const record = toRecord(syntheticDrug()) as unknown as {
      identifiers: Record<string, unknown>
    }
    delete record.identifiers['name']
    const result = fromRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('identifiers.name')
  })

  it('rejects non-finite scientific values (NaN can never be stored)', () => {
    const record = toRecord(syntheticDrug()) as unknown as {
      targets: { kd?: Record<string, unknown> }[]
    }
    if (record.targets[0]?.kd !== undefined) record.targets[0].kd['value'] = Number.NaN
    const result = fromRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toContain('kd.value')
  })

  it('never mutates the raw record it was given', () => {
    const raw = { ...toRecord(syntheticDrug()), origin: 'bogus' }
    const snapshot = structuredClone(raw)
    fromRecord(raw)
    expect(raw).toEqual(snapshot)
  })
})

describe('toStoredRecord — unknown fields survive edits', () => {
  it('carries a top-level future field forward', () => {
    const drug = syntheticDrug()
    const existing = {
      ...toRecord(drug),
      futureField: { nested: 42 },
    }
    const stored = toStoredRecord(existing, { ...drug, notes: 'edited' })
    expect((stored as unknown as Record<string, unknown>)['futureField']).toEqual({ nested: 42 })
    expect(stored.notes).toBe('edited')
  })

  it('carries nested future fields in identifiers and pharmacokinetics', () => {
    const drug = syntheticDrug()
    const existing = toRecord(drug) as unknown as Record<string, unknown>
    ;(existing['identifiers'] as Record<string, unknown>)['iupacName'] = 'invented-field'
    ;(existing['pharmacokinetics'] as Record<string, unknown>)['futureSlot'] = 7
    const stored = toStoredRecord(existing as unknown as DrugRecord, drug) as unknown as Record<
      string,
      unknown
    >
    expect((stored['identifiers'] as Record<string, unknown>)['iupacName']).toBe('invented-field')
    expect((stored['pharmacokinetics'] as Record<string, unknown>)['futureSlot']).toBe(7)
  })

  it('matches targets by stable id, not position — re-ordering cannot transplant fields', () => {
    const drug = syntheticDrug()
    const existing = toRecord(drug) as unknown as {
      targets: Record<string, unknown>[]
    }
    const first = existing.targets[0]
    if (first !== undefined) first['futureTargetField'] = 'belongs-to-TEST-R'
    // Reverse the target order in the new domain value.
    const reversed = { ...drug, targets: [...drug.targets].reverse() }
    const stored = toStoredRecord(existing as unknown as DrugRecord, reversed)
    const storedFirst = (stored as unknown as { targets: Record<string, unknown>[] }).targets[0]
    const storedSecond = (stored as unknown as { targets: Record<string, unknown>[] }).targets[1]
    expect(storedFirst?.['name']).toBe('TEST-S')
    expect(storedFirst?.['futureTargetField']).toBeUndefined()
    expect(storedSecond?.['name']).toBe('TEST-R')
    expect(storedSecond?.['futureTargetField']).toBe('belongs-to-TEST-R')
  })

  it('clearing a known field deletes it — unknown fields are not consulted', () => {
    const drug = syntheticDrug()
    const existing = toRecord(drug)
    const { notes: _cleared, ...withoutNotes } = drug
    const stored = toStoredRecord(existing, withoutNotes)
    expect('notes' in stored).toBe(false)
    expect(stored.identifiers.description).toBe(FIXTURE_NOTE)
  })

  it('keeps persistence bookkeeping: existing version carried, new records current', () => {
    const drug = syntheticDrug()
    const existing = { ...toRecord(drug, 1) }
    expect(toStoredRecord(existing, drug).persistenceVersion).toBe(1)
    expect(toStoredRecord(undefined, drug).persistenceVersion).toBe(PERSISTENCE_VERSION)
  })

  it('keeps extensions carried by the incoming drug when no previous record exists (fresh import)', () => {
    const drug = syntheticDrug()
    const target = drug.targets[0]
    if (target === undefined || target.kd === undefined) throw new Error('fixture needs kd')
    const incoming = {
      ...drug,
      futureRoot: { nested: 1 },
      identifiers: { ...drug.identifiers, futureIdentifier: 'id-ext' },
      pharmacokinetics: { ...drug.pharmacokinetics, futurePk: 'pk-ext' },
      targets: [
        {
          ...target,
          futureTarget: 'target-ext',
          kd: {
            ...target.kd,
            futureParam: 'param-ext',
            provenance: { ...target.kd.provenance, futureProvenance: 'prov-ext' },
          },
        },
        ...drug.targets.slice(1),
      ],
    } as Drug
    const stored = toStoredRecord(undefined, incoming)
    expect(fieldAt(stored, 'futureRoot')).toEqual({ nested: 1 })
    expect(fieldAt(stored, 'identifiers', 'futureIdentifier')).toBe('id-ext')
    expect(fieldAt(stored, 'targets', '0', 'futureTarget')).toBe('target-ext')
    expect(fieldAt(stored, 'targets', '0', 'kd', 'futureParam')).toBe('param-ext')
    expect(fieldAt(stored, 'targets', '0', 'kd', 'provenance', 'futureProvenance')).toBe('prov-ext')
    expect(fieldAt(stored, 'pharmacokinetics', 'futurePk')).toBe('pk-ext')
    // Known fields are governed by the domain value, not the extensions.
    expect(stored.identifiers.name).toBe(drug.identifiers.name)
    expect(fieldAt(stored, 'targets', '0', 'kd', 'value')).toBe(target.kd.value)
  })

  it('resolves extension collisions deterministically: incoming wins, stored-only is kept', () => {
    const drug = syntheticDrug()
    const existing = { ...toRecord(drug), sharedFuture: 'stored', storedOnly: 'keep' }
    const incoming = { ...drug, sharedFuture: 'incoming', incomingOnly: 'new' } as Drug
    const stored = toStoredRecord(existing, incoming)
    expect(fieldAt(stored, 'sharedFuture')).toBe('incoming')
    expect(fieldAt(stored, 'storedOnly')).toBe('keep')
    expect(fieldAt(stored, 'incomingOnly')).toBe('new')
    // An extension can never shadow a known field.
    expect(stored.notes).toBe(drug.notes)
  })
})

describe('preserveUnknownFields — documented key contract', () => {
  it('never overwrites a contract key from the previous record', () => {
    const previous = { id: 'x', origin: 'user', name: 'old-name' }
    const next = { id: 'x', origin: 'user', name: 'new-name' }
    preserveUnknownFields(previous, next)
    expect(next.name).toBe('new-name')
  })

  it('copies keys the contract does not know at any level', () => {
    const previous = { identifiers: { name: 'a', mystery: [1, 2] } }
    const next = { identifiers: { name: 'a' } }
    preserveUnknownFields(previous, next)
    expect(next.identifiers).toEqual({ name: 'a', mystery: [1, 2] })
  })
})
