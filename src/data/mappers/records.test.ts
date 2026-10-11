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

describe('sourceReferences — known target field (phase 18I)', () => {
  const CHEMBL_REF = {
    source: 'chembl',
    sourceName: 'ChEMBL',
    sourceTargetId: 'CHEMBL99991001',
    name: 'Synthetic Target A',
    organism: 'Homo sapiens',
    url: 'https://www.ebi.ac.uk/chembl/explore/target/CHEMBL99991001',
    licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
  }
  const PUBCHEM_REF = { source: 'pubchem', sourceName: 'PubChem', sourceTargetId: '12345' }

  function drugWithReferences(): Drug {
    const base = syntheticDrug()
    const [first, second] = [base.targets[0], base.targets[1]]
    if (first === undefined || second === undefined) throw new Error('fixture needs two targets')
    return {
      ...base,
      targets: [
        { ...first, sourceReferences: [CHEMBL_REF, PUBCHEM_REF] },
        second, // unchanged target: no references at all
      ],
    }
  }

  it('round-trips references through the record mapper without loss', () => {
    const drug = drugWithReferences()
    const record = toRecord(drug)
    // Written by the mapper (known field), not by unknown-field tricks.
    expect(record.targets[0]?.sourceReferences).toEqual([CHEMBL_REF, PUBCHEM_REF])
    const back = drugOf(record)
    expect(back).toEqual(drug)
  })

  it('omits the key for targets without references — never [] or undefined', () => {
    const record = toRecord(drugWithReferences())
    expect('sourceReferences' in (record.targets[1] ?? {})).toBe(false)
    // An empty domain array is also stored as absent.
    const base = syntheticDrug()
    const first = base.targets[0]
    if (first === undefined) throw new Error('fixture needs a target')
    const emptied = toRecord({ ...base, targets: [{ ...first, sourceReferences: [] }] })
    expect('sourceReferences' in (emptied.targets[0] ?? {})).toBe(false)
  })

  it('rejects a malformed reference at validation — before any write', () => {
    const record = toRecord(drugWithReferences()) as unknown as {
      targets: Record<string, unknown>[]
    }
    const refsList = record.targets[0]?.['sourceReferences'] as
      | Record<string, unknown>[]
      | undefined
    const refs = refsList?.[0]
    if (refs !== undefined) refs['url'] = 'http://insecure.example/x'
    const result = fromRecord(record)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.errors.join(' ')).toContain('sourceReferences.0.url')
    }
  })

  it('matches preserved reference extensions by source, not position', () => {
    const drug = drugWithReferences()
    const existing = toRecord(drug) as unknown as {
      targets: Record<string, unknown>[]
    }
    const refs = existing.targets[0]?.['sourceReferences'] as Record<string, unknown>[]
    if (refs[0] !== undefined) refs[0]['futureChEMBLField'] = 'kept-with-chembl'
    // The domain value now lists the references in the opposite order.
    const swapped = { ...drug, targets: swappedReferenceOrder(drug) }
    const stored = toStoredRecord(existing as unknown as DrugRecord, swapped) as unknown as {
      targets: Record<string, unknown>[]
    }
    const storedRefs = stored.targets[0]?.['sourceReferences'] as Record<string, unknown>[]
    expect(storedRefs.map((reference) => reference['source'])).toEqual(['pubchem', 'chembl'])
    expect(storedRefs[0]?.['futureChEMBLField']).toBeUndefined()
    expect(storedRefs[1]?.['futureChEMBLField']).toBe('kept-with-chembl')
  })

  it('keeps references on their own target when targets are reordered', () => {
    const drug = drugWithReferences()
    const reversed: Drug = { ...drug, targets: [...drug.targets].reverse() }
    const stored = toRecord(reversed)
    const testS = stored.targets.find((target) => target.name === 'TEST-S')
    const testR = stored.targets.find((target) => target.name === 'TEST-R')
    expect('sourceReferences' in (testS ?? {})).toBe(false) // TEST-S never had any
    expect(testR?.sourceReferences?.map((reference) => reference.source)).toEqual([
      'chembl',
      'pubchem',
    ])
  })

  function swappedReferenceOrder(drug: Drug): Drug['targets'] {
    const [first, second] = [drug.targets[0], drug.targets[1]]
    if (first === undefined || second === undefined) throw new Error('fixture needs two targets')
    return [
      { ...first, sourceReferences: [PUBCHEM_REF, CHEMBL_REF] },
      second,
    ]
  }
})
