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
