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
