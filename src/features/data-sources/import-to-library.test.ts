/**
 * Data Sources → Drug Library import, end to end (phase 36), against the
 * real Dexie repositories with scripted fake adapters (no network):
 *
 * - a complete PubChem compound import keeps every identifier and chemical
 *   property the adapter supplied;
 * - a complete ChEMBL import keeps attribution, license terms and every
 *   stored measurement with its endpoint, qualifier, unit, target, species,
 *   assay and provenance;
 * - missing optional fields stay absent — nothing is fabricated;
 * - a compound with no observations imports cleanly;
 * - repeat imports are identity-aware and never duplicate a record or a
 *   measurement;
 * - a same-name/different-identity record is never silently merged;
 * - linking an existing manual drug preserves its targets, parameters,
 *   target metadata and notes;
 * - a conflicting same-source identity is reported instead of overwritten;
 * - an import never sets a model parameter, and the explicit "Use as
 *   parameter…" flow still applies its own validation.
 *
 * All record content is synthetic test data — not pharmacological
 * information.
 */
import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  FIXTURE_TIMESTAMP,
  syntheticCompound,
  syntheticDrug,
  syntheticLibrary,
  syntheticObservation,
} from '../../tests/fixtures'
import { SandboxDatabase } from '../../data/db/database'
import { DexieDrugRepository } from '../../data/repositories/dexieDrugRepository'
import { DexieSourceDataRepository } from '../../data/repositories/dexieSourceDataRepository'
import type { Drug } from '../../domain/drug/drug'
import type { RemoteCompound } from '../../domain/sources/compound'
import type { RemoteObservation } from '../../domain/sources/observation'
import type { SourceAdapter } from '../../data/sources/types'
import { createDataSourcesStore } from './store'

let sequence = 0
function freshName(): string {
  sequence += 1
  return `source-import-${Date.now()}-${sequence}`
}

type Store = ReturnType<typeof createDataSourcesStore>

let db: SandboxDatabase
let sourceRepo: DexieSourceDataRepository
let drugRepo: DexieDrugRepository

beforeEach(() => {
  db = new SandboxDatabase(freshName())
  sourceRepo = new DexieSourceDataRepository(db)
  drugRepo = new DexieDrugRepository(db)
})

afterEach(async () => {
  vi.unstubAllGlobals()
  await db.delete()
})

function makeStore(adapters: readonly SourceAdapter[] = []): Store {
  return createDataSourcesStore({
    sourceRepository: sourceRepo,
    drugRepository: drugRepo,
    adapters:
      adapters.length > 0
        ? adapters
        : [
            {
              id: 'fake',
              name: 'Fake Source',
              description: 'synthetic test adapter',
              capabilities: { searchScopes: ['compounds'], observations: false },
              searchCompounds: async () => [],
            },
          ],
  })
}

/** A complete PubChem-shaped compound (every supported field populated). */
function pubchemCompound(overrides: Partial<RemoteCompound> = {}): RemoteCompound {
  return {
    id: 'pubchem:90000001',
    source: 'pubchem',
    sourceId: '90000001',
    name: 'Synthetic Fixture Compound',
    synonyms: ['SFC-1', 'Fixture Alias'],
    identifiers: {
      pubchemCid: '90000001',
      inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
      molecularFormula: 'C12H14N2O',
      molecularWeight: 202.25,
      casNumber: 'SYNTH-CAS-0001',
    },
    provenance: {
      source: 'pubchem',
      sourceName: 'PubChem',
      recordId: '90000001',
      url: 'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
      retrievedAt: FIXTURE_TIMESTAMP,
      licenseNotice: 'PubChem aggregates contributions from many data providers.',
      licenseUrl: 'https://pubchem.ncbi.nlm.nih.gov/docs/downloads',
    },
    createdAt: FIXTURE_TIMESTAMP,
    updatedAt: FIXTURE_TIMESTAMP,
    ...overrides,
  }
}

async function seed(
  store: Store,
  compounds: readonly RemoteCompound[],
  observations: readonly RemoteObservation[] = [],
): Promise<void> {
  const report = await sourceRepo.importSourceRecords({ compounds, observations })
  expect(report.ok).toBe(true)
  await store.getState().hydrateStored()
}

describe('complete compound import — PubChem', () => {
  it('keeps every identifier and chemical property the source supplied', async () => {
    const store = makeStore()
    await seed(store, [pubchemCompound()])
    const outcome = await store.getState().addToLibrary('pubchem:90000001')
    expect(outcome.status).toBe('created')
    if (outcome.status !== 'created') throw new Error('expected created')

    const snapshot = outcome.drug.sourceRecords?.[0]
    expect(snapshot?.source).toBe('pubchem')
    expect(snapshot?.sourceId).toBe('90000001')
    expect(snapshot?.name).toBe('Synthetic Fixture Compound')
    expect(snapshot?.synonyms).toEqual(['SFC-1', 'Fixture Alias'])
    expect(snapshot?.identifiers).toEqual({
      pubchemCid: '90000001',
      inchiKey: 'FIXTUREKEYSXYZ-UHFFFAOYSA-N',
      smiles: 'CCN(CC)C(=O)C1=CC=CC=C1NC1=CC=CC=C1',
      molecularFormula: 'C12H14N2O',
      molecularWeight: 202.25,
      casNumber: 'SYNTH-CAS-0001',
    })
    // The drug record's own identifiers carry name/synonyms/CAS as before.
    expect(outcome.drug.identifiers).toEqual({
      name: 'Synthetic Fixture Compound',
      synonyms: ['SFC-1', 'Fixture Alias'],
      casNumber: 'SYNTH-CAS-0001',
    })
    // Source attribution travels in structured fields, not in notes.
    expect(outcome.drug.notes).toBeUndefined()
    expect(snapshot?.provenance).toEqual({
      source: 'pubchem',
      sourceName: 'PubChem',
      recordId: '90000001',
      url: 'https://pubchem.ncbi.nlm.nih.gov/compound/90000001',
      retrievedAt: FIXTURE_TIMESTAMP,
      licenseNotice: 'PubChem aggregates contributions from many data providers.',
      licenseUrl: 'https://pubchem.ncbi.nlm.nih.gov/docs/downloads',
    })
    // A PubChem import carries no measurements and invents no parameter.
    expect(snapshot?.observations).toEqual([])
    expect(outcome.drug.targets).toEqual([])
  })
})

describe('complete compound import — ChEMBL', () => {
  it('preserves attribution and the associated measurement in full', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()], [syntheticObservation()])
    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    expect(outcome.status).toBe('created')
    if (outcome.status !== 'created') throw new Error('expected created')

    const snapshot = outcome.drug.sourceRecords?.[0]
    expect(snapshot?.provenance).toEqual({
      source: 'chembl',
      sourceName: 'ChEMBL',
      recordId: 'CHEMBL99990001',
      url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990001',
      retrievedAt: FIXTURE_TIMESTAMP,
      licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
    })
    expect(snapshot?.observations).toHaveLength(1)
    const observation = snapshot?.observations[0]
    expect(observation).toMatchObject({
      id: 'chembl:99000001',
      compoundId: 'chembl:CHEMBL99990001',
      compoundSourceId: 'CHEMBL99990001',
      endpoint: 'IC50',
      parameterKind: 'ic50',
      value: 3.5,
      unit: 'nM',
      qualifier: '=',
      species: 'Homo sapiens',
      target: {
        name: 'Synthetic Target A',
        sourceTargetId: 'CHEMBL99991001',
        sourceTargetUrl: 'https://www.ebi.ac.uk/chembl/explore/target/CHEMBL99991001',
        organism: 'Homo sapiens',
      },
      provenance: {
        source: 'chembl',
        recordId: '99000001',
        url: 'https://www.ebi.ac.uk/chembl/api/data/activity.json?activity_id=99000001',
        licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
      },
    })
    // An imported measurement is NOT a model parameter.
    expect(outcome.drug.targets).toEqual([])
    expect(outcome.addedObservations).toBe(1)
  })

  it('keeps assay, comment, qualifier and raw relation when the source reports them', async () => {
    const store = makeStore()
    const { parameterKind: _unmapped, unit: _noUnit, qualifier: _noQualifier, ...base } =
      syntheticObservation()
    const detailed: RemoteObservation = {
      ...base,
      id: 'chembl:99000031',
      endpoint: "Log K'",
      value: 1.39,
      rawRelation: '>>',
      assay: {
        assayId: 'CHEMBL99992001',
        assayType: 'B',
        description: 'Synthetic fixture binding assay (test data)',
      },
      reference: { referenceId: 'CHEMBL99993001', journal: 'Synthetic J', year: 2026 },
      activityComment: 'Synthetic activity comment',
      dataValidityNote: 'Synthetic validity note',
      provenance: { ...syntheticObservation().provenance, recordId: '99000031' },
    }
    // Absent keys must stay absent — never written as explicit undefined.
    await seed(store, [syntheticCompound()], [detailed])
    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (outcome.status !== 'created') throw new Error('expected created')
    const observation = outcome.drug.sourceRecords?.[0]?.observations[0]
    expect(observation).toEqual(detailed)
    expect(Object.prototype.hasOwnProperty.call(observation ?? {}, 'parameterKind')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(observation ?? {}, 'unit')).toBe(false)
    expect(observation?.assay?.assayId).toBe('CHEMBL99992001')
    expect(observation?.reference?.year).toBe(2026)
    expect(observation?.activityComment).toBe('Synthetic activity comment')
    expect(observation?.dataValidityNote).toBe('Synthetic validity note')
    expect(observation?.rawRelation).toBe('>>')
    expect(observation?.parameterKind).toBeUndefined()
  })
})

describe('missing fields stay missing', () => {
  it('never fabricates an identifier or property the source did not supply', async () => {
    const store = makeStore()
    const { name: _noName, ...sparseBase } = pubchemCompound({
      synonyms: [],
      identifiers: { pubchemCid: '90000001' },
    })
    const sparse: RemoteCompound = sparseBase
    await seed(store, [sparse])
    const outcome = await store.getState().addToLibrary('pubchem:90000001')
    if (outcome.status !== 'created') throw new Error('expected created')

    const snapshot = outcome.drug.sourceRecords?.[0]
    expect(snapshot?.name).toBeUndefined()
    expect(snapshot?.synonyms).toEqual([])
    expect(snapshot?.identifiers).toEqual({ pubchemCid: '90000001' })
    for (const key of [
      'inchiKey',
      'smiles',
      'molecularFormula',
      'molecularWeight',
      'casNumber',
      'chemblId',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(snapshot?.identifiers ?? {}, key)).toBe(false)
    }
    // No identifier was invented for the name either — the source id is
    // used as the display fallback, which is honest.
    expect(outcome.drug.identifiers.name).toBe('90000001')
    expect(outcome.drug.identifiers.casNumber).toBeUndefined()
  })

  it('reports an honest zero-measurement result for a compound with none', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()])
    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (outcome.status !== 'created') throw new Error('expected created')
    expect(outcome.drug.sourceRecords?.[0]?.observations).toEqual([])
    expect(outcome.addedObservations).toBe(0)
    expect(outcome.observationCount).toBe(0)
    expect(store.getState().actionNotice).toContain('no stored measurements')
  })
})

describe('identity, duplicates and repeat imports', () => {
  it('a repeated import is idempotent — no duplicate record, no duplicate measurement', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()], [syntheticObservation()])
    const first = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (first.status !== 'created') throw new Error('expected created')

    const second = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    expect(second.status).toBe('created') // a NEW record is still requested…
    const drugs = (await drugRepo.getAllDrugs()).drugs
    // …and the two records each carry exactly one snapshot and one measurement.
    expect(drugs).toHaveLength(2)
    for (const drug of drugs) {
      expect(drug.sourceRecords).toHaveLength(1)
      expect(drug.sourceRecords?.[0]?.observations).toHaveLength(1)
    }
  })

  it('re-importing into the SAME record reports already-linked and adds nothing twice', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()], [syntheticObservation()])
    const created = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (created.status !== 'created') throw new Error('expected created')

    const again = await store
      .getState()
      .addToLibrary('chembl:CHEMBL99990001', { drugId: created.drug.id })
    expect(again.status).toBe('already-linked')
    if (again.status !== 'already-linked') throw new Error('expected already-linked')
    expect(again.addedObservations).toBe(0)
    expect(again.observationCount).toBe(1)
    const stored = await drugRepo.getDrug(created.drug.id)
    expect(stored?.sourceRecords?.[0]?.observations).toHaveLength(1)
  })

  it('adds measurements stored since the last import without duplicating the old ones', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()], [syntheticObservation()])
    const created = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (created.status !== 'created') throw new Error('expected created')

    const later: RemoteObservation = {
      ...syntheticObservation(),
      id: 'chembl:99000041',
      endpoint: 'Ki',
      parameterKind: 'ki',
      value: 12,
      qualifier: '>',
      provenance: { ...syntheticObservation().provenance, recordId: '99000041' },
    }
    const report = await sourceRepo.importSourceRecords({ compounds: [], observations: [later] })
    expect(report.ok).toBe(true)
    await store.getState().hydrateStored()

    const refreshed = await store
      .getState()
      .addToLibrary('chembl:CHEMBL99990001', { drugId: created.drug.id })
    expect(refreshed.status).toBe('already-linked')
    if (refreshed.status !== 'already-linked') throw new Error('expected already-linked')
    expect(refreshed.addedObservations).toBe(1)
    const stored = await drugRepo.getDrug(created.drug.id)
    expect(stored?.sourceRecords?.[0]?.observations.map((observation) => observation.id)).toEqual([
      'chembl:99000001',
      'chembl:99000041',
    ])
  })

  it('never associates observations that belong to a different source compound id', async () => {
    const store = makeStore()
    const other: RemoteObservation = {
      ...syntheticObservation(),
      id: 'chembl:99000051',
      compoundId: 'chembl:CHEMBL99990002',
      compoundSourceId: 'CHEMBL99990002',
      // The DISPLAY NAME deliberately matches the other compound.
      compoundName: 'Synthetic Fixture Compound',
      provenance: { ...syntheticObservation().provenance, recordId: '99000051' },
    }
    const sibling: RemoteCompound = {
      ...syntheticCompound(),
      id: 'chembl:CHEMBL99990002',
      sourceId: 'CHEMBL99990002',
      identifiers: { chemblId: 'CHEMBL99990002' },
      provenance: {
        ...syntheticCompound().provenance,
        recordId: 'CHEMBL99990002',
        url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990002',
      },
    }
    await seed(store, [syntheticCompound(), sibling], [syntheticObservation(), other])

    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (outcome.status !== 'created') throw new Error('expected created')
    expect(outcome.drug.sourceRecords?.[0]?.observations.map((observation) => observation.id)).toEqual(
      ['chembl:99000001'],
    )

    const siblingOutcome = await store.getState().addToLibrary('chembl:CHEMBL99990002')
    if (siblingOutcome.status !== 'created') throw new Error('expected created')
    expect(
      siblingOutcome.drug.sourceRecords?.[0]?.observations.map((observation) => observation.id),
    ).toEqual(['chembl:99000051'])
  })

  it('a same-name, different-identity compound is a separate record — never merged', async () => {
    const store = makeStore()
    const sameName: RemoteCompound = {
      ...syntheticCompound(),
      id: 'chembl:CHEMBL99990009',
      sourceId: 'CHEMBL99990009',
      name: 'Synthetic Fixture Compound', // identical display name
      identifiers: { chemblId: 'CHEMBL99990009' },
      provenance: {
        ...syntheticCompound().provenance,
        recordId: 'CHEMBL99990009',
        url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990009',
      },
    }
    await seed(store, [syntheticCompound(), sameName], [])
    const first = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    const second = await store.getState().addToLibrary('chembl:CHEMBL99990009')
    if (first.status !== 'created' || second.status !== 'created') {
      throw new Error('expected two created records')
    }
    expect(first.drug.id).not.toBe(second.drug.id)
    const drugs = (await drugRepo.getAllDrugs()).drugs
    expect(drugs).toHaveLength(2)
    expect(
      drugs.map((drug) => drug.sourceRecords?.[0]?.sourceId).sort(),
    ).toEqual(['CHEMBL99990001', 'CHEMBL99990009'])
  })

  it('reports a same-source identity conflict when linking to a record that holds another', async () => {
    const store = makeStore()
    const other: RemoteCompound = {
      ...syntheticCompound(),
      id: 'chembl:CHEMBL99990009',
      sourceId: 'CHEMBL99990009',
      identifiers: { chemblId: 'CHEMBL99990009' },
      provenance: {
        ...syntheticCompound().provenance,
        recordId: 'CHEMBL99990009',
        url: 'https://www.ebi.ac.uk/chembl/explore/compound/CHEMBL99990009',
      },
    }
    await seed(store, [syntheticCompound(), other], [])
    const created = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (created.status !== 'created') throw new Error('expected created')

    const conflict = await store
      .getState()
      .addToLibrary('chembl:CHEMBL99990009', { drugId: created.drug.id })
    expect(conflict.status).toBe('conflict')
    if (conflict.status !== 'conflict') throw new Error('expected conflict')
    expect(conflict.existing.sourceId).toBe('CHEMBL99990001')
    expect(conflict.message).toContain('different ChEMBL record')

    // Nothing was merged or overwritten.
    const stored = await drugRepo.getDrug(created.drug.id)
    expect(stored?.sourceRecords?.map((record) => record.sourceId)).toEqual(['CHEMBL99990001'])
    expect(store.getState().actionError).toContain('different ChEMBL record')
  })
})

describe('linking an existing manual drug record', () => {
  async function manualDrug(): Promise<Drug> {
    await drugRepo.replaceLibrary(syntheticLibrary([syntheticDrug()]))
    return syntheticDrug()
  }

  it('preserves targets, model parameters, target metadata and notes', async () => {
    const manual = await manualDrug()
    const store = makeStore()
    await seed(store, [syntheticCompound()], [syntheticObservation()])

    const outcome = await store
      .getState()
      .addToLibrary('chembl:CHEMBL99990001', { drugId: manual.id })
    expect(outcome.status).toBe('linked')
    if (outcome.status !== 'linked') throw new Error('expected linked')

    const stored = await drugRepo.getDrug(manual.id)
    expect(stored?.targets).toEqual(manual.targets)
    expect(stored?.identifiers).toEqual(manual.identifiers)
    expect(stored?.notes).toBe(manual.notes)
    expect(stored?.tags).toEqual(manual.tags)
    expect(stored?.pharmacokinetics).toEqual(manual.pharmacokinetics)
    // …and the source data arrived alongside, not instead.
    expect(stored?.sourceRecords).toHaveLength(1)
    expect(stored?.sourceRecords?.[0]?.observations).toHaveLength(1)
  })

  it('refuses to link to a record that is no longer in the library', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()], [])
    const outcome = await store
      .getState()
      .addToLibrary('chembl:CHEMBL99990001', { drugId: 'no-such-drug' })
    expect(outcome.status).toBe('failed')
    expect(store.getState().actionError).toContain('no longer in the library')
    expect((await drugRepo.getAllDrugs()).drugs).toEqual([])
  })

  it('does not select a link target by name — the caller must name the id', async () => {
    await manualDrug()
    const store = makeStore()
    await seed(store, [syntheticCompound()], [])
    // No drugId → a NEW record, even though a name-similar one exists.
    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    expect(outcome.status).toBe('created')
    expect((await drugRepo.getAllDrugs()).drugs).toHaveLength(2)
  })
})

describe('import never sets a model parameter', () => {
  it('leaves every parameter slot empty and the apply flow still validates', async () => {
    const store = makeStore()
    await seed(store, [syntheticCompound()], [syntheticObservation()])
    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (outcome.status !== 'created') throw new Error('expected created')
    expect(outcome.drug.targets).toEqual([])

    // The measurement is still promotable through the explicit flow.
    const applied = await store.getState().applyObservation({
      observationId: 'chembl:99000001',
      drugId: outcome.drug.id,
      targetId: null,
      overwrite: false,
    })
    expect(applied).toBe(true)
    const stored = await drugRepo.getDrug(outcome.drug.id)
    expect(stored?.targets[0]?.ic50?.value).toBe(3.5)
    expect(stored?.targets[0]?.ic50?.provenance).toMatchObject({
      observationId: 'chembl:99000001',
    })
    // The snapshot is untouched by the promotion.
    expect(stored?.sourceRecords?.[0]?.observations).toHaveLength(1)
  })

  it('an ineligible measurement stays a record and is refused as a parameter', async () => {
    const store = makeStore()
    const bounded: RemoteObservation = { ...syntheticObservation(), qualifier: '<' }
    await seed(store, [syntheticCompound()], [bounded])
    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    if (outcome.status !== 'created') throw new Error('expected created')
    // It is preserved in the snapshot…
    expect(outcome.drug.sourceRecords?.[0]?.observations[0]?.qualifier).toBe('<')

    // …but the existing validation still refuses it as a parameter.
    const applied = await store.getState().applyObservation({
      observationId: 'chembl:99000001',
      drugId: outcome.drug.id,
      targetId: null,
      overwrite: false,
    })
    expect(applied).toBe(false)
    expect(store.getState().actionError).toContain('"<"')
    const stored = await drugRepo.getDrug(outcome.drug.id)
    expect(stored?.targets).toEqual([])
  })
})

describe('no unexpected network traffic', () => {
  it('the whole import path performs zero external requests', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const store = makeStore()
    await seed(store, [syntheticCompound()], [syntheticObservation()])
    const outcome = await store.getState().addToLibrary('chembl:CHEMBL99990001')
    expect(outcome.status).toBe('created')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
