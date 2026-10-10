/**
 * Dexie/IndexedDB implementation of the repository contract.
 *
 * This is the only module that knows both the interface and the storage
 * schema. Guarantees:
 * - every mutation validates through the shared NPSL schema before it is
 *   written (garbage in → typed `RepositoryError('VALIDATION')`, never a
 *   corrupt record);
 * - multi-record operations (`replaceLibrary`, `importLibrary`, single
 *   CRUD + metadata stamp) run inside one Dexie transaction — all-or-
 *   nothing; duplicate ids, schema failures and merge-vs-quarantine id
 *   collisions reject inside the transaction and leave the previous
 *   library untouched;
 * - hydration reports invalid records as quarantine instead of deleting or
 *   skipping them silently;
 * - library `updatedAt` is stamped by CRUD mutations only — an import
 *   carries the file's own timestamps (round-trip identity);
 * - storage origin (`origin`) and scientific provenance are distinct: this
 *   layer preserves both verbatim and never rewrites provenance.
 */
import type { Drug, DrugId, ReceptorTarget } from '../../domain/drug/drug'
import {
  DEFAULT_LIBRARY_ID,
  type DrugLibrary,
  type LibraryMetadata,
} from '../../domain/library/library'
import type { SandboxDatabase } from '../db/database'
import {
  parseNpsl,
  resolveLibraryMetadata,
  validateNpslFile,
  type ImportIssue,
} from '../import/importPipeline'
import { newId } from '../id'
import {
  PERSISTENCE_VERSION,
  fromRecord,
  toStoredRecord,
  type DrugRecord,
} from '../mappers/records'
import {
  buildRecoveryArchive,
  buildRecoveryWarnings,
  classifyArchiveDrugs,
  parseRecoveryArchive,
  type RawSnapshotRow,
  type ValidatedArchive,
} from '../recovery/archive'
import { drugSchema, libraryMetadataSchema } from '../schemas/npsl'
import {
  RepositoryError,
  type DrugChanges,
  type DrugInput,
  type DrugRepository,
  type ImportMode,
  type ImportReport,
  type LibraryLoadResult,
  type QuarantinedRecord,
  type RecoveryExportOutcome,
  type RecoveryPreviewOutcome,
  type RecoveryReport,
  type RecoveryRestoreOutcome,
  type TargetInput,
} from './repository'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function recordKey(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return '(missing id)'
}

function schemaErrors(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ')
}

function assignTargetIds(targets: readonly TargetInput[]): readonly ReceptorTarget[] {
  return targets.map((target) =>
    target.id !== undefined && target.id !== ''
      ? // Narrowed above; TargetInput only widens the id to optional.
        (target as ReceptorTarget)
      : { ...target, id: newId() },
  )
}

type MutableDrug = { -readonly [K in keyof Drug]: Drug[K] }

function applyChanges(current: Drug, changes: DrugChanges, now: string): Drug {
  const draft: MutableDrug = {
    ...current,
    createdAt: current.createdAt ?? now,
    updatedAt: now,
  }
  if (changes.identifiers !== undefined) draft.identifiers = changes.identifiers
  if (changes.tags !== undefined) draft.tags = changes.tags
  if (changes.targets !== undefined) draft.targets = assignTargetIds(changes.targets)
  if (changes.pharmacokinetics !== undefined) draft.pharmacokinetics = changes.pharmacokinetics
  if ('notes' in changes) {
    // Explicit undefined clears; absent keeps (see DrugChanges contract).
    if (changes.notes === undefined) delete draft.notes
    else draft.notes = changes.notes
  }
  return draft
}

function defaultMetadata(now: string): LibraryMetadata {
  return {
    id: DEFAULT_LIBRARY_ID,
    name: 'Local library',
    createdAt: now,
    updatedAt: now,
    // Empty first run: nothing is claimed about data we do not have.
    dataStatus: 'unspecified',
  }
}

export class DexieDrugRepository implements DrugRepository {
  private readonly db: SandboxDatabase

  constructor(db: SandboxDatabase) {
    this.db = db
  }

  async getAllDrugs(): Promise<LibraryLoadResult> {
    const raws: unknown[] = await this.db.drugs.toArray()
    const drugs: Drug[] = []
    const quarantine: QuarantinedRecord[] = []
    for (const raw of raws) {
      const result = fromRecord(raw)
      if (result.ok) {
        drugs.push(result.drug)
      } else {
        // Kept exactly as stored — repair is possible, deletion is not
        // something hydration ever does on its own.
        quarantine.push({ id: recordKey(raw), errors: result.errors, record: raw })
      }
    }
    return { drugs, quarantine }
  }

  async getDrug(id: DrugId): Promise<Drug | undefined> {
    const raw: DrugRecord | undefined = await this.db.drugs.get(id)
    if (raw === undefined) return undefined
    const result = fromRecord(raw)
    if (!result.ok) {
      throw new RepositoryError(
        'VALIDATION',
        `stored record "${id}" is invalid: ${result.errors.join('; ')}`,
      )
    }
    return result.drug
  }

  async createDrug(input: DrugInput): Promise<Drug> {
    const now = new Date().toISOString()
    const drug: Drug = {
      id: newId(),
      origin: 'user',
      identifiers: input.identifiers,
      tags: input.tags ?? [],
      targets: assignTargetIds(input.targets ?? []),
      pharmacokinetics: input.pharmacokinetics ?? {},
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      createdAt: now,
      updatedAt: now,
    }
    const record = toStoredRecord(undefined, drug)
    assertWritable(record)
    await this.db.transaction('rw', this.db.drugs, this.db.meta, async () => {
      await this.db.drugs.put(record)
      await this.touchLibrary(now)
    })
    return drug
  }

  async updateDrug(id: DrugId, changes: DrugChanges): Promise<Drug> {
    return this.db.transaction('rw', this.db.drugs, this.db.meta, async () => {
      const existing: DrugRecord | undefined = await this.db.drugs.get(id)
      if (existing === undefined) {
        throw new RepositoryError('NOT_FOUND', `no drug with id "${id}"`)
      }
      const current = fromRecord(existing)
      if (!current.ok) {
        throw new RepositoryError(
          'VALIDATION',
          `stored record "${id}" is invalid: ${current.errors.join('; ')}`,
        )
      }
      const now = new Date().toISOString()
      const next = applyChanges(current.drug, changes, now)
      const record = toStoredRecord(existing, next)
      assertWritable(record)
      await this.db.drugs.put(record)
      await this.touchLibrary(now)
      return next
    })
  }

  async deleteDrug(id: DrugId): Promise<void> {
    await this.db.transaction('rw', this.db.drugs, this.db.meta, async () => {
      const existing: DrugRecord | undefined = await this.db.drugs.get(id)
      if (existing === undefined) {
        throw new RepositoryError('NOT_FOUND', `no drug with id "${id}"`)
      }
      await this.db.drugs.delete(id)
      await this.touchLibrary()
    })
  }

  async getLibraryMetadata(): Promise<LibraryMetadata> {
    const all = await this.db.meta.toArray()
    const existing = all[0]
    if (existing !== undefined) return existing
    // First run: one documented default entry (never invented pharmacology).
    const fresh = defaultMetadata(new Date().toISOString())
    await this.db.meta.put(fresh)
    return fresh
  }

  async replaceLibrary(next: DrugLibrary): Promise<void> {
    await this.db.transaction('rw', this.db.drugs, this.db.meta, async () => {
      // Full validation before the first write: duplicate ids and schema
      // violations reject here, inside the transaction, so the current
      // library survives a failed replacement untouched.
      const metadata = libraryMetadataSchema.safeParse(next.metadata)
      if (!metadata.success) {
        throw new RepositoryError(
          'VALIDATION',
          `library metadata rejected: ${schemaErrors(metadata.error.issues)}`,
        )
      }
      const seen = new Set<DrugId>()
      const records: DrugRecord[] = []
      for (const drug of next.drugs) {
        if (seen.has(drug.id)) {
          throw new RepositoryError(
            'VALIDATION',
            `duplicate drug id "${drug.id}" in replacement library`,
          )
        }
        seen.add(drug.id)
        const record = toStoredRecord(undefined, drug)
        assertWritable(record)
        records.push(record)
      }
      await this.db.drugs.clear()
      for (const record of records) await this.db.drugs.put(record)
      await this.db.meta.clear()
      await this.db.meta.put(next.metadata)
    })
  }

  async importLibrary(
    text: string,
    options: { readonly mode: ImportMode },
  ): Promise<ImportReport> {
    // Step 1 (outside the transaction): JSON + envelope version check —
    // cheap, and a broken file never opens a write transaction.
    const parsed = parseNpsl(text)
    if (!parsed.ok) return { ok: false, errors: parsed.errors, warnings: [] }

    // Steps 2–5 run inside the transaction: schema, semantic validation
    // (including duplicate-id rejection), then the atomic commit. A
    // validation failure returns without a single write.
    return this.db.transaction('rw', this.db.drugs, this.db.meta, async () => {
      const validation = validateNpslFile(parsed.file)
      if (!validation.ok) {
        return { ok: false, errors: validation.errors, warnings: validation.warnings }
      }

      let created = 0
      let updated = 0
      if (options.mode === 'replace') {
        await this.db.drugs.clear()
        for (const drug of validation.drugs) {
          await this.db.drugs.put(toStoredRecord(undefined, drug))
        }
        const currentMeta = (await this.db.meta.toArray())[0]
        await this.db.meta.clear()
        await this.db.meta.put(
          resolveLibraryMetadata(validation.metadata, currentMeta?.id ?? DEFAULT_LIBRARY_ID),
        )
        created = validation.drugs.length
      } else {
        // Merge vs quarantine (audit GAP-3): a stored row that fails the
        // authoritative hydration classifier (`fromRecord`, the exact logic
        // `getAllDrugs` uses to build the quarantine report) must never be
        // overwritten by a valid incoming record. The pre-scan runs inside
        // this same transaction BEFORE the first write, so the rows cannot
        // change between detection and commit, and a rejection can never
        // partially apply: the whole document is refused while every raw
        // row — quarantined, valid-new, valid-update — stays byte-identical.
        // Returning normally here commits nothing (reads only so far).
        const existingById = new Map<DrugId, DrugRecord>()
        const conflicts: ImportIssue[] = []
        for (const [index, drug] of validation.drugs.entries()) {
          const existing: DrugRecord | undefined = await this.db.drugs.get(drug.id)
          if (existing === undefined) continue
          existingById.set(drug.id, existing)
          if (!fromRecord(existing).ok) {
            conflicts.push({
              code: 'QUARANTINE_CONFLICT',
              path: `drugs.${index}`,
              message: `stored record "${drug.id}" fails schema validation and is quarantined; the merge import was rejected and the quarantined record was preserved unchanged, with nothing from this file written. Resolve the quarantine conflict for "${drug.id}" before importing this id.`,
            })
          }
        }
        if (conflicts.length > 0) {
          return { ok: false, errors: conflicts, warnings: validation.warnings }
        }
        for (const drug of validation.drugs) {
          const existing = existingById.get(drug.id)
          await this.db.drugs.put(toStoredRecord(existing, drug))
          if (existing !== undefined) updated += 1
          else created += 1
        }
        // Merge deliberately does not touch library metadata: the import
        // carries the file's own timestamps, CRUD alone stamps updatedAt.
      }

      return {
        ok: true,
        mode: options.mode,
        total: validation.drugs.length,
        created,
        updated,
        warnings: validation.warnings,
      }
    })
  }

  async exportLibrary(): Promise<DrugLibrary> {
    const metadata = await this.getLibraryMetadata()
    const { drugs } = await this.getAllDrugs()
    // Quarantined records are unreadable and therefore not exported; they
    // remain in storage and visible in the quarantine report.
    return { metadata, drugs }
  }

  async exportRecoveryArchive(): Promise<RecoveryExportOutcome> {
    let snapshot: { drugs: RawSnapshotRow[]; meta: RawSnapshotRow[] }
    try {
      // One read-only transaction over BOTH stores (docs/recovery-backup.md
      // §7): cursor callbacks capture the real IndexedDB primary key next
      // to each structured-cloned value, and both reads finish inside the
      // transaction before any CPU-heavy work (scanning, classification,
      // serialization) runs on the copies — so counts and entries can
      // never mix the pre- and post-write sides of a concurrent change.
      // No fallback path: a read failure is fail-closed BACKUP_READ_FAILED.
      snapshot = await this.db.transaction('r', this.db.drugs, this.db.meta, async () => {
        const drugs: RawSnapshotRow[] = []
        await this.db.drugs.each((value, cursor) => {
          drugs.push({ key: cursor.primaryKey, value })
        })
        const meta: RawSnapshotRow[] = []
        await this.db.meta.each((value, cursor) => {
          meta.push({ key: cursor.primaryKey, value })
        })
        return { drugs, meta }
      })
    } catch (error) {
      return {
        ok: false,
        issues: [
          {
            code: 'BACKUP_READ_FAILED',
            message: `the local library could not be read for backup: ${messageOf(error)}`,
          },
        ],
      }
    }
    return buildRecoveryArchive({
      drugs: snapshot.drugs,
      meta: snapshot.meta,
      storage: {
        databaseVersion: this.db.verno,
        persistenceVersion: PERSISTENCE_VERSION,
      },
      exportedAt: new Date().toISOString(),
    })
  }

  async previewRecoveryArchive(text: string): Promise<RecoveryPreviewOutcome> {
    const parsed = parseRecoveryArchive(text)
    if (!parsed.ok) return { ok: false, issues: parsed.issues }
    return { ok: true, report: this.recoveryReport(parsed.archive) }
  }

  async restoreRecoveryArchive(text: string): Promise<RecoveryRestoreOutcome> {
    // Complete §8.2 validation BEFORE the first write: a rejected archive
    // never opens a write transaction, so the library stays untouched.
    const parsed = parseRecoveryArchive(text)
    if (!parsed.ok) return { ok: false, issues: parsed.issues }
    const report = this.recoveryReport(parsed.archive)

    // Raw, verbatim writes are confined to this one operation (ADR-18):
    // validated JSON-domain rows are written as stored — no schema
    // re-validation, no normalization, no bookkeeping backfill — so
    // unknown fields and quarantined rows survive exactly. `put` derives
    // the key from the in-line `id`, which validation proved equals the
    // entry key. Both stores are cleared and rewritten inside one `rw`
    // transaction: full replacement, atomic (any failure aborts and rolls
    // back — the previous library is intact), and never partially mixed.
    await this.db.transaction('rw', this.db.drugs, this.db.meta, async () => {
      await this.db.drugs.clear()
      await this.db.meta.clear()
      for (const row of parsed.archive.drugs) {
        await this.db.drugs.put(row.value as unknown as DrugRecord)
      }
      for (const row of parsed.archive.meta) {
        await this.db.meta.put(row.value as unknown as LibraryMetadata)
      }
    })
    return { ok: true, report }
  }

  /** Archive counts + this build's derived classification and warnings. */
  private recoveryReport(archive: ValidatedArchive): RecoveryReport {
    const currentBuild = classifyArchiveDrugs(archive.drugs)
    return {
      counts: archive.counts,
      currentBuild,
      warnings: buildRecoveryWarnings(
        archive,
        {
          databaseVersion: this.db.verno,
          persistenceVersion: PERSISTENCE_VERSION,
        },
        currentBuild,
      ),
    }
  }

  /** CRUD stamp: library-level updatedAt, single metadata entry. */
  private async touchLibrary(now: string = new Date().toISOString()): Promise<void> {
    const all = await this.db.meta.toArray()
    const current = all[0]
    if (current !== undefined) await this.db.meta.put({ ...current, updatedAt: now })
    else await this.db.meta.put(defaultMetadata(now))
  }
}

function assertWritable(record: DrugRecord): void {
  const parsed = drugSchema.safeParse(record)
  if (!parsed.success) {
    throw new RepositoryError(
      'VALIDATION',
      `drug record rejected: ${schemaErrors(parsed.error.issues)}`,
    )
  }
}
