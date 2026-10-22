/**
 * Recovery repository tests (ADR-18): snapshot export over ONE read
 * transaction (quarantine-inclusive counts, fail-closed read errors),
 * preview reports, full-replacement restore inside ONE write transaction
 * (rollback on failure), verbatim preservation of quarantined rows and
 * unknown fields, and mutual rejection with ordinary `.npsl` import.
 *
 * All fixtures are synthetic test data — not pharmacological information.
 */
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import {
  syntheticDrug,
  syntheticDrugB,
  syntheticMetadata,
  syntheticNpslText,
} from '../../tests/fixtures'
import type { Drug } from '../../domain/drug/drug'
import { SandboxDatabase } from '../db/database'
import { toRecord } from '../mappers/records'
import { DexieDrugRepository } from './dexieDrugRepository'

let sequence = 0
function freshDb(): SandboxDatabase {
  sequence += 1
  return new SandboxDatabase(`recovery-repo-test-${Date.now()}-${sequence}`)
}

const QUARANTINED_ROW = {
  id: 'raw-quarantined-row',
  origin: 'bogus',
  name: 123,
  futureField: { keep: true },
}

/** One readable record, one quarantined raw row, one metadata row. */
async function seededDb(): Promise<{ db: SandboxDatabase; recordId: string }> {
  const db = freshDb()
  const record = toRecord(syntheticDrug())
  await db.drugs.put(record)
  await db.drugs.put(QUARANTINED_ROW as never)
  await db.meta.put(syntheticMetadata({ name: 'Recovery fixture library' }))
  return { db, recordId: record.id }
}

describe('DexieDrugRepository — recovery export', () => {
  it('exports a read-only snapshot with quarantine-inclusive counts', async () => {
    const { db, recordId } = await seededDb()
    try {
      const repo = new DexieDrugRepository(db)
      const beforeDrugs = await db.drugs.toArray()
      const beforeMeta = await db.meta.toArray()

      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      expect(exported.counts).toEqual({
        drugRows: 2,
        readableAtExport: 1,
        quarantinedAtExport: 1,
        metaRows: 1,
        compoundRows: 0,
        observationRows: 0,
        scenarioRows: 0,
        experimentDatasetRows: 0,
      })

      const doc = JSON.parse(exported.text) as {
        formatId: string
        drugs: { key: string }[]
        meta: { key: string }[]
      }
      expect(doc.formatId).toBe('npsb')
      expect(doc.drugs.map((entry) => entry.key).sort()).toEqual(
        [recordId, QUARANTINED_ROW.id].sort(),
      )
      expect(doc.meta.map((entry) => entry.key)).toEqual(['fixture-library'])

      // Export never mutates storage.
      expect(await db.drugs.toArray()).toEqual(beforeDrugs)
      expect(await db.meta.toArray()).toEqual(beforeMeta)
    } finally {
      await db.delete()
    }
  })

  it('fails closed with BACKUP_READ_FAILED when the snapshot read cannot complete', async () => {
    const { db } = await seededDb()
    try {
      const repo = new DexieDrugRepository(db)
      const eachSpy = vi.spyOn(db.drugs, 'each').mockImplementationOnce(() => {
        // Synchronous failure inside the read transaction: the callback
        // rejects, the transaction aborts, and export fails closed.
        throw new Error('read exploded')
      })
      const result = await repo.exportRecoveryArchive()
      eachSpy.mockRestore()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected a read failure')
      expect(result.issues[0]?.code).toBe('BACKUP_READ_FAILED')
      expect(result.issues[0]?.message).toContain('could not be read for backup')
      expect('text' in result).toBe(false)
    } finally {
      await db.delete()
    }
  })

  it('refuses stored values outside the JSON domain with store/key/path/type diagnostics', async () => {
    const db = freshDb()
    try {
      await db.drugs.put({ id: 'date-row', recordedAt: new Date() } as never)
      const repo = new DexieDrugRepository(db)

      const result = await repo.exportRecoveryArchive()
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.issues[0]).toMatchObject({
        code: 'BACKUP_UNSUPPORTED_VALUE',
        store: 'drugs',
        key: 'date-row',
        path: '/recordedAt',
        valueType: 'date',
      })
    } finally {
      await db.delete()
    }
  })

  it('refuses non-string primary keys', async () => {
    const db = freshDb()
    try {
      await db.drugs.put({ id: 42, label: 'numeric key row' } as never)
      const repo = new DexieDrugRepository(db)

      const result = await repo.exportRecoveryArchive()
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      expect(result.issues[0]).toMatchObject({
        code: 'BACKUP_UNSUPPORTED_KEY',
        store: 'drugs',
        valueType: 'number',
      })
    } finally {
      await db.delete()
    }
  })

  it('captures both stores in one read transaction so counts never straddle a concurrent write', async () => {
    const db = freshDb()
    const db2 = new SandboxDatabase(db.name) // second connection, same database
    try {
      const repo = new DexieDrugRepository(db)
      await db.drugs.put(toRecord(syntheticDrug()))
      await db.meta.put(syntheticMetadata())

      // Kick a write from the other connection the moment the snapshot
      // starts iterating: transaction scope locks must defer it until the
      // read transaction finishes.
      const originalEach = db.drugs.each.bind(db.drugs)
      let concurrent: Promise<unknown> | undefined
      const eachSpy = vi
        .spyOn(db.drugs, 'each')
        .mockImplementation((callback: Parameters<typeof db.drugs.each>[0]) => {
          concurrent ??= db2.drugs.put(toRecord(syntheticDrugB()))
          return originalEach(callback)
        })
      const exported = await repo.exportRecoveryArchive()
      eachSpy.mockRestore()
      await concurrent

      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      // The snapshot is internally consistent AND does not contain the
      // concurrent row: it was written after the read transaction closed.
      expect(exported.counts.drugRows).toBe(1)
      expect(
        exported.counts.readableAtExport + exported.counts.quarantinedAtExport,
      ).toBe(exported.counts.drugRows)
      expect(await db2.drugs.count()).toBe(2) // the concurrent write did land
    } finally {
      await db.delete()
    }
  })
})

describe('DexieDrugRepository — recovery preview and restore', () => {
  it('previews a validated report: archive counts, this-build classification, no warnings', async () => {
    const { db } = await seededDb()
    try {
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))

      const preview = await repo.previewRecoveryArchive(exported.text)
      if (!preview.ok) throw new Error(JSON.stringify(preview.issues))
      expect(preview.report.counts).toEqual(exported.counts)
      expect(preview.report.currentBuild).toEqual({ readable: 1, quarantined: 1 })
      expect(preview.report.warnings).toEqual([])
    } finally {
      await db.delete()
    }
  })

  it('restores raw rows verbatim — quarantine, unknown fields and metadata included', async () => {
    const { db, recordId } = await seededDb()
    try {
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))

      // Replace the library with unrelated content first.
      await db.drugs.clear()
      await db.meta.clear()
      await db.drugs.put(toRecord(syntheticDrugB()))
      await db.meta.put(syntheticMetadata({ name: 'Different library' }))

      const restored = await repo.restoreRecoveryArchive(exported.text)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      expect(restored.report.counts).toEqual(exported.counts)
      expect(restored.report.currentBuild).toEqual({ readable: 1, quarantined: 1 })
      expect(restored.report.warnings).toEqual([])

      // Verbatim rows: the quarantined raw row and its unknown field are
      // exactly what the snapshot captured, no schema pass, no rewrites.
      expect(await db.drugs.get(QUARANTINED_ROW.id)).toEqual(QUARANTINED_ROW)
      expect(await db.drugs.get(recordId)).toEqual(toRecord(syntheticDrug()))
      expect(await db.drugs.count()).toBe(2)
      // Full replacement of BOTH stores: the unrelated record and the
      // different metadata are gone, not merged alongside.
      expect(await db.drugs.get('fixture-drug-2')).toBeUndefined()
      expect(await db.meta.count()).toBe(1)
      const meta = await db.meta.get('fixture-library')
      expect(meta?.name).toBe('Recovery fixture library')
    } finally {
      await db.delete()
    }
  })

  it('restores target source references verbatim — lossless through export/restore', async () => {
    const db = freshDb()
    try {
      const reference = {
        source: 'chembl',
        sourceName: 'ChEMBL',
        sourceTargetId: 'CHEMBL99991001',
        name: 'TEST-R',
        organism: 'synthetic',
        url: 'https://www.ebi.ac.uk/chembl/explore/target/CHEMBL99991001',
        licenseNotice: 'ChEMBL data is licensed under CC BY-SA 3.0.',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
      }
      const base = syntheticDrug()
      const first = base.targets[0]
      if (first === undefined) throw new Error('fixture needs a target')
      const drug: Drug = { ...base, targets: [{ ...first, sourceReferences: [reference] }] }
      const record = toRecord(drug)
      await db.drugs.put(record)

      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      await db.drugs.clear()

      const restored = await repo.restoreRecoveryArchive(exported.text)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      // Phase 18I: the reference rides the raw-row guarantee exactly —
      // no schema pass, no rewrite, byte-level round trip.
      expect(await db.drugs.get(record.id)).toEqual(record)
      const reread = await repo.getDrug(record.id)
      expect(reread?.targets[0]?.sourceReferences).toEqual([reference])
    } finally {
      await db.delete()
    }
  })

  it('preserves a duplicate-source reference row verbatim — raw recovery ignores schema rules (18I.1)', async () => {
    const db = freshDb()
    try {
      const referenceA = {
        source: 'chembl',
        sourceName: 'ChEMBL',
        sourceTargetId: 'CHEMBL99991001',
        name: 'TEST-R',
      }
      const referenceB = {
        source: 'chembl',
        sourceName: 'ChEMBL',
        sourceTargetId: 'CHEMBL99991002',
        name: 'TEST-R',
      }
      const base = syntheticDrug()
      const first = base.targets[0]
      if (first === undefined) throw new Error('fixture needs a target')
      const record = toRecord({ ...base, targets: [{ ...first, sourceReferences: [referenceA] }] })
      // Malformed under the 18I.1 invariant: two references from the SAME
      // source. The archive is a raw snapshot — it must keep them verbatim.
      const malformed = {
        ...record,
        targets: record.targets.map((target, index) =>
          index === 0 ? { ...target, sourceReferences: [referenceA, referenceB] } : target,
        ),
      }
      await db.drugs.put(malformed)

      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      await db.drugs.clear()

      const restored = await repo.restoreRecoveryArchive(exported.text)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      // No schema pass, no deduplication, no repair — byte-identical rows;
      // the archive's own report classifies the row for the current build.
      expect(restored.report.currentBuild).toEqual({ readable: 0, quarantined: 1 })
      expect(await db.drugs.get(record.id)).toEqual(malformed)
      // The normal validator explains the problem at hydration instead…
      const loaded = await repo.getAllDrugs()
      expect(loaded.quarantine).toHaveLength(1)
      expect(loaded.quarantine[0]?.id).toBe(record.id)
      expect(loaded.quarantine[0]?.errors.join(' ')).toContain('duplicate source reference')
      // …and still leaves the stored row untouched afterwards.
      expect(await db.drugs.get(record.id)).toEqual(malformed)
    } finally {
      await db.delete()
    }
  })

  it('repairs a quarantined duplicate-reference row through a deliberately edited archive (18I.2)', async () => {
    const db = freshDb()
    try {
      // Seed: a malformed row (two references with the same exact source,
      // unknown fields at drug, target and reference level), one separate
      // valid row, and library metadata (with an unknown field).
      const validRecord = toRecord(syntheticDrug())
      const retainedReference = {
        source: 'chembl',
        sourceName: 'ChEMBL',
        sourceTargetId: 'CHEMBL99991001',
        name: 'TEST-R',
        futureReferenceField: 'kept',
      }
      const duplicateReference = {
        source: 'chembl',
        sourceName: 'ChEMBL',
        sourceTargetId: 'CHEMBL99991002',
        name: 'TEST-R',
      }
      const base = syntheticDrug({
        id: 'fixture-drug-dup',
        identifiers: { name: 'Fixture Compound Repair', synonyms: [] },
      })
      const first = base.targets[0]
      if (first === undefined) throw new Error('fixture needs a target')
      const malformedRow = {
        ...toRecord({
          ...base,
          targets: [{ ...first, sourceReferences: [retainedReference, duplicateReference] }],
        }),
        futureDrugField: 'kept',
      }
      const metadataRow = {
        ...syntheticMetadata({ name: 'Repair fixture library' }),
        futureMetaField: 'kept',
      }
      await db.drugs.put(validRecord)
      await db.drugs.put(malformedRow)
      await db.meta.put(metadataRow)

      const repo = new DexieDrugRepository(db)
      // Hydration quarantines the malformed row and leaves it unchanged.
      const quarantined = await repo.getAllDrugs()
      expect(quarantined.drugs.map((d) => d.id)).toEqual(['fixture-drug-1'])
      expect(quarantined.quarantine.map((q) => q.id)).toEqual(['fixture-drug-dup'])
      expect(await db.drugs.get('fixture-drug-dup')).toEqual(malformedRow)

      // The `.npsb` export is a raw snapshot: it carries the quarantined
      // row too. The original text is the user's untouched backup copy.
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      const originalText = exported.text
      expect(exported.counts).toMatchObject({
        drugRows: 2,
        readableAtExport: 1,
        quarantinedAtExport: 1,
        metaRows: 1,
      })

      // The deliberate, explicit user-choice edit: retain ONE reference and
      // remove the duplicate from that target's sourceReferences array —
      // located via the archive contract (drugs entries keyed by the row's
      // own id). No production code performs this choice: the schema never
      // deduplicates and the restore path never rewrites rows.
      const archive = JSON.parse(originalText) as {
        readonly drugs: { key: string; value: Record<string, unknown> }[]
      }
      const entry = archive.drugs.find((candidate) => candidate.key === 'fixture-drug-dup')
      if (entry === undefined) throw new Error('the archive must carry the quarantined row')
      const targets = entry.value['targets'] as Record<string, unknown>[]
      const target = targets[0]
      if (target === undefined) throw new Error('the row must carry a target')
      target['sourceReferences'] = [retainedReference]
      const editedText = JSON.stringify(archive, null, 2)
      expect(editedText).not.toBe(originalText)

      // A structurally broken edit is still rejected before any write —
      // acceptance follows the normal §8.2 validation, nothing else.
      const broken = JSON.parse(editedText) as {
        readonly drugs: { key: string; value: Record<string, unknown> }[]
      }
      const brokenEntry = broken.drugs.find((candidate) => candidate.key === 'fixture-drug-dup')
      if (brokenEntry === undefined) throw new Error('the edited archive lost the row')
      brokenEntry.key = 'fixture-drug-gone' // key must equal the value's own id
      const rejected = await repo.restoreRecoveryArchive(JSON.stringify(broken, null, 2))
      expect(rejected.ok).toBe(false)
      if (!rejected.ok) expect(rejected.issues[0]?.code).toBe('ARCHIVE_KEY_MISMATCH')
      expect(await db.drugs.get('fixture-drug-dup')).toEqual(malformedRow)

      // Preview is honest about the edit: the archive recorded a quarantined
      // row, this build classifies the repaired one as readable.
      const preview = await repo.previewRecoveryArchive(editedText)
      if (!preview.ok) throw new Error(JSON.stringify(preview.issues))
      expect(preview.report.counts.quarantinedAtExport).toBe(1)
      expect(preview.report.currentBuild).toEqual({ readable: 2, quarantined: 0 })
      expect(preview.report.warnings.map((w) => w.code)).toContain('RECLASSIFICATION_DIFFERS')

      const restored = await repo.restoreRecoveryArchive(editedText)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      expect(restored.report.counts).toEqual(exported.counts)
      expect(restored.report.currentBuild).toEqual({ readable: 2, quarantined: 0 })

      // The repaired drug is readable with exactly the retained reference —
      // its values and unknown extension fields intact — and only the
      // deliberate change was applied to the row.
      const expectedRepairedRow = {
        ...malformedRow,
        targets: malformedRow.targets.map((target2, index) =>
          index === 0 ? { ...target2, sourceReferences: [retainedReference] } : target2,
        ),
      }
      expect(await db.drugs.get('fixture-drug-dup')).toEqual(expectedRepairedRow)
      const repaired = await repo.getDrug('fixture-drug-dup')
      expect(repaired?.targets[0]?.sourceReferences).toEqual([retainedReference])

      // Everything else survived the full-snapshot round trip: the unrelated
      // valid row and all metadata (unknown field included) are unchanged,
      // with no silent row loss or unexpected row creation.
      expect(await db.drugs.get('fixture-drug-1')).toEqual(validRecord)
      expect(await db.meta.get('fixture-library')).toEqual(metadataRow)
      expect((await repo.getLibraryMetadata()).name).toBe('Repair fixture library')
      expect(await db.drugs.count()).toBe(2)
      const after = await repo.getAllDrugs()
      expect(after.drugs).toHaveLength(2)
      // The quarantine report agrees with the restore report (0 quarantined).
      expect(after.quarantine).toEqual([])

      // The original exported archive string is unchanged and still previews
      // as the pre-repair snapshot (1 readable / 1 quarantined).
      const untouched = await repo.previewRecoveryArchive(originalText)
      if (!untouched.ok) throw new Error(JSON.stringify(untouched.issues))
      expect(untouched.report.currentBuild).toEqual({ readable: 1, quarantined: 1 })
    } finally {
      await db.delete()
    }
  })

  // Phase 18I.2.1 — shared seed for the sidecar-safety cases: the malformed
  // row's LATER references carry special numbers (annotated in the `.npsb`
  // sidecar), plus a valid row and metadata. Synthetic test data only.
  async function seededSidecarDb() {
    const db = freshDb()
    const validRecord = toRecord(syntheticDrug())
    const retainedReference = {
      source: 'chembl',
      sourceName: 'ChEMBL',
      sourceTargetId: 'CHEMBL99991001',
      name: 'TEST-R',
      futureReferenceField: 'kept',
    }
    const duplicateReference = {
      source: 'chembl',
      sourceName: 'ChEMBL',
      sourceTargetId: 'CHEMBL99991002',
      name: 'TEST-R',
      futureNumberField: Number.NaN,
    }
    const shiftedReference = {
      source: 'pubchem',
      sourceName: 'PubChem',
      sourceTargetId: '12345',
      futureNumberField: Number.POSITIVE_INFINITY,
    }
    const laterReference = {
      source: 'guidepharm',
      sourceName: 'GuidePHARM',
      sourceTargetId: 'G-1',
      // A plain `null` — the SAME JSON placeholder shape an annotated
      // NaN/±Infinity would serialize to (§6.3): the hazard's enabler.
      futureNumberField: null,
    }
    const base = syntheticDrug({
      id: 'fixture-drug-sidecar',
      identifiers: { name: 'Fixture Compound Sidecar', synonyms: [] },
    })
    const first = base.targets[0]
    if (first === undefined) throw new Error('fixture needs a target')
    // The mapper writes known fields only (unknown reference keys drop on a
    // create — referenceToRecord/preserveUnknownFields need an existing row),
    // so `toRecord` maps the known shape and the RAW reference objects —
    // unknown fields and their special numbers included — are attached at the
    // storage layer. That stored shape is what the `.npsb` exporter snapshots
    // and annotates (phase 18I.2.1).
    const mapped = toRecord({
      ...base,
      targets: [{ ...first, sourceReferences: [] }],
    })
    const malformedRow = {
      ...mapped,
      targets: mapped.targets.map((target, index) =>
        index === 0
          ? {
              ...target,
              sourceReferences: [
                retainedReference,
                duplicateReference,
                shiftedReference,
                laterReference,
              ],
            }
          : target,
      ),
      futureDrugField: Number.NaN,
    }
    const metadataRow = {
      ...syntheticMetadata({ name: 'Sidecar fixture library' }),
      futureMetaField: 'kept',
    }
    await db.drugs.put(validRecord)
    await db.drugs.put(malformedRow as never)
    await db.meta.put(metadataRow)
    return { db, validRecord, metadataRow }
  }

  interface SidecarArchiveEntry {
    key: string
    value: Record<string, unknown>
    specialNumbers?: { path: string; kind: string }[]
  }

  function parseArchiveTree(text: string): {
    archive: { drugs: SidecarArchiveEntry[] }
    entry: SidecarArchiveEntry
  } {
    const archive = JSON.parse(text) as { drugs: SidecarArchiveEntry[] }
    const entry = archive.drugs.find((candidate) => candidate.key === 'fixture-drug-sidecar')
    if (entry === undefined) throw new Error('the archive must carry the malformed row')
    return { archive, entry }
  }

  function sidecarReferences(entry: SidecarArchiveEntry): Record<string, unknown>[] {
    const targets = entry.value['targets'] as Record<string, unknown>[]
    const target = targets[0]
    if (target === undefined) throw new Error('the row must carry a target')
    const references = target['sourceReferences']
    if (!Array.isArray(references)) throw new Error('the target must carry sourceReferences')
    return references as Record<string, unknown>[]
  }

  it('shows the stale-sidecar hazard: an unadjusted pointer rebuilds the number at the shifted destination (18I.2.1)', async () => {
    const { db, validRecord, metadataRow } = await seededSidecarDb()
    try {
      const repo = new DexieDrugRepository(db)
      expect((await repo.getAllDrugs()).quarantine.map((q) => q.id)).toEqual(['fixture-drug-sidecar'])

      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))

      // The sidecar points at the ORIGINAL array indexes of the stored row:
      // the duplicate's NaN at index 1, the PubChem Infinity at index 2.
      const { archive, entry } = parseArchiveTree(exported.text)
      expect(entry.specialNumbers).toContainEqual({
        path: '/targets/0/sourceReferences/1/futureNumberField',
        kind: 'NaN',
      })
      expect(entry.specialNumbers).toContainEqual({
        path: '/targets/0/sourceReferences/2/futureNumberField',
        kind: 'Infinity',
      })

      // The documented repair performed LAZILY: the duplicate reference is
      // removed, the sidecar is left untouched (still naming indexes 1 and 2).
      sidecarReferences(entry).splice(1, 1)
      const editedText = JSON.stringify(archive, null, 2)

      // ACTUAL parser behavior: the archive is ACCEPTED. The stale pointers
      // still resolve — every shifted destination carries a compatible `null`
      // placeholder at the same property name (§6.3 checks the CURRENT
      // placeholder, it never authenticates the original file) — and the
      // special numbers are reconstructed at the SHIFTED destinations. This
      // is a silent semantic change, NOT a repair: a documented hazard of
      // hand-edited unsigned archives (docs/recovery-backup.md §11). No
      // production code guards it, by design.
      const restored = await repo.restoreRecoveryArchive(editedText)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      expect(restored.report.currentBuild).toEqual({ readable: 2, quarantined: 0 })

      const rawRow = (await db.drugs.get('fixture-drug-sidecar')) as unknown as {
        readonly futureDrugField: number
        readonly targets: readonly {
          readonly sourceReferences: readonly Record<string, unknown>[]
        }[]
      }
      const stored = rawRow.targets[0]?.sourceReferences ?? []
      expect(stored.map((reference) => reference['sourceTargetId'])).toEqual([
        'CHEMBL99991001',
        '12345',
        'G-1',
      ])
      // The PubChem reference (index 1 after the shift) LOST its Infinity and
      // now carries the DELETED duplicate's NaN: the stale index-1 annotation
      // rebound to the shifted element because its `null` placeholder happens
      // to be compatible with the `NaN` kind (§6.3).
      expect(Object.is(stored[1]?.['futureNumberField'], Number.NaN)).toBe(true)
      // The GuidePHARM reference (index 2 after the shift) GAINED an Infinity
      // it never stored: the stale index-2 annotation landed on the element
      // that shifted into its place.
      expect(stored[2]?.['futureNumberField']).toBe(Infinity)
      // The drug-level annotation outside the array is unaffected.
      expect(Object.is(rawRow.futureDrugField, Number.NaN)).toBe(true)
      // Nothing catches the corruption: the row validates as readable —
      // schema, quarantine and hydration all see a structurally sound row.
      expect((await repo.getAllDrugs()).quarantine).toEqual([])
      // Unrelated rows and metadata are unchanged; no row loss or creation.
      expect(await db.drugs.get('fixture-drug-1')).toEqual(validRecord)
      expect(await db.meta.get('fixture-library')).toEqual(metadataRow)
      expect(await db.drugs.count()).toBe(2)
    } finally {
      await db.delete()
    }
  })

  it('repairs with a deliberately adjusted sidecar — removed, reindexed and preserved annotations (18I.2.1)', async () => {
    const { db, validRecord, metadataRow } = await seededSidecarDb()
    try {
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))

      // Same starting archive as the hazard case; only the sidecar handling
      // differs. 1. Remove the duplicate (the explicit user choice: keep the
      // first chembl reference).
      const { archive, entry } = parseArchiveTree(exported.text)
      sidecarReferences(entry).splice(1, 1)
      // 2. Adjust the sidecar to the edited structure: an annotation whose
      //    owner was deleted goes with it; an annotation into the array at or
      //    after the removed index is reindexed; everything else is preserved.
      entry.specialNumbers = (entry.specialNumbers ?? []).flatMap((annotation) => {
        if (annotation.path === '/targets/0/sourceReferences/1/futureNumberField') return []
        if (annotation.path === '/targets/0/sourceReferences/2/futureNumberField') {
          return [{ ...annotation, path: '/targets/0/sourceReferences/1/futureNumberField' }]
        }
        return [annotation]
      })
      const repairedText = JSON.stringify(archive, null, 2)

      // Structural validation plus correct placeholders: accepted. A wrong
      // adjustment would instead fail loudly (ARCHIVE_ANNOTATION_* codes).
      const preview = await repo.previewRecoveryArchive(repairedText)
      if (!preview.ok) throw new Error(JSON.stringify(preview.issues))
      expect(preview.report.currentBuild).toEqual({ readable: 2, quarantined: 0 })

      const restored = await repo.restoreRecoveryArchive(repairedText)
      if (!restored.ok) throw new Error(JSON.stringify(restored.issues))
      expect(restored.report.currentBuild).toEqual({ readable: 2, quarantined: 0 })

      // The duplicate source entry is gone; every pointer resolved to its
      // intended property: the special number is reconstructed at the
      // INTENDED (PubChem) reference and nothing else moved.
      const rawRow = (await db.drugs.get('fixture-drug-sidecar')) as unknown as {
        readonly futureDrugField: number
        readonly targets: readonly {
          readonly sourceReferences: readonly Record<string, unknown>[]
        }[]
      }
      const stored = rawRow.targets[0]?.sourceReferences ?? []
      expect(stored.map((reference) => reference['source'])).toEqual(['chembl', 'pubchem', 'guidepharm'])
      expect(stored[1]?.['futureNumberField']).toBe(Infinity)
      expect(stored[2]?.['futureNumberField']).toBeNull()
      // The preserved drug-level annotation outside the array still
      // reconstructs, and unknown fields survive (row-level NaN field and
      // the reference-level `futureReferenceField`).
      expect(Object.is(rawRow.futureDrugField, Number.NaN)).toBe(true)
      expect(stored[0]?.['futureReferenceField']).toBe('kept')
      const repaired = await repo.getDrug('fixture-drug-sidecar')
      expect(repaired?.targets[0]?.sourceReferences?.[0]?.sourceTargetId).toBe('CHEMBL99991001')
      // Unrelated rows and metadata remain unchanged; the record is readable.
      expect(await db.drugs.get('fixture-drug-1')).toEqual(validRecord)
      expect(await db.meta.get('fixture-library')).toEqual(metadataRow)
      expect(await db.drugs.count()).toBe(2)
      expect((await repo.getAllDrugs()).quarantine).toEqual([])
    } finally {
      await db.delete()
    }
  })

  it('rejects an invalid archive before opening any write transaction', async () => {
    const { db } = await seededDb()
    try {
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      const corrupted = exported.text.replace(
        '"formatId": "npsb"',
        '"formatId": "npsb",\n  "formatId": "npsb"',
      )

      const beforeDrugs = await db.drugs.toArray()
      const txnSpy = vi.spyOn(db, 'transaction')
      const result = await repo.restoreRecoveryArchive(corrupted)
      txnSpy.mockRestore()

      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected rejection')
      expect(result.issues[0]?.code).toBe('ARCHIVE_DUPLICATE_JSON_KEY')
      // Fail-closed: validation never reaches a transaction at all.
      expect(txnSpy).not.toHaveBeenCalled()
      expect(await db.drugs.toArray()).toEqual(beforeDrugs)
    } finally {
      await db.delete()
    }
  })

  it('rolls back the whole restore when a write inside the transaction fails', async () => {
    const { db } = await seededDb()
    try {
      const repo = new DexieDrugRepository(db)
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      const beforeDrugs = await db.drugs.toArray()
      const beforeMeta = await db.meta.toArray()

      const putSpy = vi.spyOn(db.meta, 'put').mockImplementationOnce(() => {
        throw new Error('simulated write failure')
      })
      try {
        await expect(repo.restoreRecoveryArchive(exported.text)).rejects.toThrow()
      } finally {
        putSpy.mockRestore()
      }

      // Nothing committed: both stores still hold the pre-restore rows.
      expect(await db.drugs.toArray()).toEqual(beforeDrugs)
      expect(await db.meta.toArray()).toEqual(beforeMeta)
      expect(await db.drugs.count()).toBe(2)
    } finally {
      await db.delete()
    }
  })

  it('rejects .npsl text in the restore path and .npsb text in the import path', async () => {
    const { db } = await seededDb()
    try {
      const repo = new DexieDrugRepository(db)

      // Ordinary NPSL document → restore refuses with import guidance.
      const preview = await repo.previewRecoveryArchive(
        syntheticNpslText([syntheticDrug()]),
      )
      expect(preview.ok).toBe(false)
      if (preview.ok) throw new Error('expected rejection')
      expect(preview.issues[0]?.code).toBe('ARCHIVE_NOT_NPSB')

      // Recovery archive → ordinary import refuses it (wrong envelope).
      const exported = await repo.exportRecoveryArchive()
      if (!exported.ok) throw new Error(JSON.stringify(exported.issues))
      const imported = await repo.importLibrary(exported.text, { mode: 'replace' })
      expect(imported.ok).toBe(false)
      if (imported.ok) throw new Error('expected import failure')
      expect(imported.errors.some((error) => /formatVersion/i.test(error.message))).toBe(true)

      // Both failures left the library untouched.
      expect(await db.drugs.count()).toBe(2)
      expect(await db.meta.count()).toBe(1)
    } finally {
      await db.delete()
    }
  })
})
