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
 *   layer preserves both verbatim and never rewrites provenance;
 * - optimistic concurrency (phase 20, ADR-21): every per-record editor
 *   write (`updateDrug`, `deleteDrug`) carries the revision its action
 *   is based on, and the revision comparison + the row write or row
 *   deletion + revision bump run inside ONE read-write transaction over
 *   `drugs`+`meta`+`revisions` — an action based on a superseded state
 *   rejects with `RepositoryError('CONFLICT')` before anything is
 *   stored or deleted. Full-snapshot bulk paths (import, replace,
 *   restore) take no token; they bump every written id's revision
 *   instead, which invalidates any editor token issued before them.
 *   `deleteDrug` keeps the revision tombstone (and does not advance it —
 *   a deleted row makes every stale action fail `NOT_FOUND`), so
 *   delete → re-create can never restart the sequence and resurrect an
 *   old token.
 */
import type { Drug, DrugId, ReceptorTarget } from '../../domain/drug/drug'
import type { SavedScenario } from '../../domain/simulation/saved-scenario'
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
  type DrugRevision,
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

/**
 * Interchange boundary (phase 20, ADR-21): the concurrency token is
 * storage-local session bookkeeping, never portable data. Exports strip
 * it so NPSL round-trip identity is unaffected — a revision number says
 * nothing about the record's science and must not travel with it.
 */
function stripRevision(drug: Drug): Drug {
  const { revision: _revision, ...rest } = drug
  return rest
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
  // Phase 36: imported source data is only ever replaced by a caller that
  // explicitly supplies it (the attach flow). An ordinary edit omits the
  // key, so source-derived identifiers, attribution and measurements are
  // structurally unreachable from the form path and cannot be erased by it.
  if (changes.sourceRecords !== undefined) {
    if (changes.sourceRecords.length === 0) delete draft.sourceRecords
    else draft.sourceRecords = changes.sourceRecords
  }
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
    // Both tables in ONE read transaction (phase 20): a hydration snapshot
    // and its revision tokens must come from the same consistent view —
    // reading them in separate transactions could attach a post-commit
    // revision to pre-commit values, minting a token that would then
    // validate a stale draft (exactly the race the token exists to stop).
    const [raws, revisionRows] = await this.db.transaction(
      'r',
      this.db.drugs,
      this.db.revisions,
      async () =>
        [
          await this.db.drugs.toArray(),
          await this.db.revisions.toArray(),
        ] as const,
    )
    const revisions = new Map<DrugId, number>(revisionRows.map((row) => [row.id, row.revision]))
    const drugs: Drug[] = []
    const quarantine: QuarantinedRecord[] = []
    for (const raw of raws) {
      const result = fromRecord(raw)
      if (result.ok) {
        // Revision 0 = "no revisions row": a record never written under
        // the token scheme (pre-v4 database or raw-seeded fixture). 0 is
        // the correct token for it — the first edit moves it to 1 and any
        // stale 0-token save then conflicts.
        drugs.push({ ...result.drug, revision: revisions.get(recordKey(raw)) ?? 0 })
      } else {
        // Kept exactly as stored — repair is possible, deletion is not
        // something hydration ever does on its own.
        quarantine.push({ id: recordKey(raw), errors: result.errors, record: raw })
      }
    }
    return { drugs, quarantine }
  }

  async getDrug(id: DrugId): Promise<Drug | undefined> {
    // Same consistent-view rule as getAllDrugs (phase 20).
    const [raw, revision] = await this.db.transaction(
      'r',
      this.db.drugs,
      this.db.revisions,
      async () =>
        [
          await this.db.drugs.get(id),
          await this.db.revisions.get(id),
        ] as const,
    )
    if (raw === undefined) return undefined
    const result = fromRecord(raw)
    if (!result.ok) {
      throw new RepositoryError(
        'VALIDATION',
        `stored record "${id}" is invalid: ${result.errors.join('; ')}`,
      )
    }
    return { ...result.drug, revision: revision?.revision ?? 0 }
  }

  async createDrug(input: DrugInput): Promise<Drug> {
    const now = new Date().toISOString()
    const id = newId()
    const drug: Drug = {
      id,
      origin: 'user',
      identifiers: input.identifiers,
      tags: input.tags ?? [],
      targets: assignTargetIds(input.targets ?? []),
      pharmacokinetics: input.pharmacokinetics ?? {},
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      // Phase 36: an import-created record carries its source snapshot from
      // the first write. An empty list stays absent (never `[]`).
      ...(input.sourceRecords !== undefined && input.sourceRecords.length > 0
        ? { sourceRecords: input.sourceRecords }
        : {}),
      createdAt: now,
      updatedAt: now,
    }
    const record = toStoredRecord(undefined, drug)
    assertWritable(record)
    // The revision starts its monotonic sequence here (phase 20): a fresh
    // UUID reads as 1; the bump helper keeps any pre-existing tombstone's
    // sequence, so even a hypothetical id re-creation can never hand out
    // a revision an old edit token already holds.
    const revision = await this.db.transaction(
      'rw',
      this.db.drugs,
      this.db.meta,
      this.db.revisions,
      async () => {
        await this.db.drugs.put(record)
        await this.touchLibrary(now)
        return this.bumpRevision(id)
      },
    )
    return { ...drug, revision }
  }

  async updateDrug(id: DrugId, changes: DrugChanges, expectedRevision: number): Promise<Drug> {
    return this.db.transaction(
      'rw',
      this.db.drugs,
      this.db.meta,
      this.db.revisions,
      async () => {
        const existing: DrugRecord | undefined = await this.db.drugs.get(id)
        if (existing === undefined) {
          throw new RepositoryError('NOT_FOUND', `no drug with id "${id}"`)
        }
        // Optimistic concurrency check (phase 20, ADR-21). The stored
        // revision is read HERE, inside the same read-write transaction
        // as the record write below. IndexedDB serializes overlapping
        // readwrite transactions on the same stores: a competing
        // `updateDrug` (or an import/replace/restore revision bump) has
        // either fully committed or not yet started when this read runs,
        // so the comparison and the write are ONE atomic step — there is
        // no time-of-check/time-of-use window, and two writers sharing
        // one stale expected revision cannot both commit. A mismatch
        // throws (transaction aborts): nothing — record, scientific
        // values, revision, metadata — is modified.
        const storedRevision = await this.currentRevision(id)
        if (storedRevision !== expectedRevision) {
          throw new RepositoryError(
            'CONFLICT',
            `record "${id}" changed elsewhere: the edit was based on revision ${expectedRevision}, but the stored record is at revision ${storedRevision} — reload the record and re-apply the edit`,
          )
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
        // Advance the token so this commit's own revision can never be
        // replayed by an editor still holding the previous one.
        const revision = await this.bumpRevision(id)
        return { ...next, revision }
      },
    )
  }

  async deleteDrug(id: DrugId, expectedRevision: number): Promise<void> {
    // Revision guard (phase 20 review fix): the token comparison shares
    // the deletion's own read-write transaction, so there is no window
    // in which a stale delete can pass the check and then act on newer
    // data — a stale token aborts before the row is touched.
    await this.db.transaction(
      'rw',
      this.db.drugs,
      this.db.meta,
      this.db.revisions,
      async () => {
        const existing: DrugRecord | undefined = await this.db.drugs.get(id)
        if (existing === undefined) {
          // Includes the concurrent-delete case: by the time this
          // transaction runs, the row is gone — nothing left to guard.
          throw new RepositoryError('NOT_FOUND', `no drug with id "${id}"`)
        }
        const storedRevision = await this.currentRevision(id)
        if (storedRevision !== expectedRevision) {
          throw new RepositoryError(
            'CONFLICT',
            `record "${id}" changed elsewhere: the deletion was based on revision ${expectedRevision}, but the stored record is at revision ${storedRevision} — nothing was deleted; reload the record and review it before deleting again`,
          )
        }
        // The revision tombstone is deliberately KEPT and deliberately NOT
        // advanced (phase 20 review decision, ADR-21): revisions are
        // monotonic per id for the lifetime of the database, and every
        // path that (re)writes a row — create, import, replace, restore —
        // bumps above the tombstone, so an edit or delete token issued
        // before this deletion can never match a later record. Advancing
        // here would add no safety (with the row gone every stale action
        // already fails `NOT_FOUND`) and would blur "the sequence advanced
        // because data changed" with bookkeeping.
        await this.db.drugs.delete(id)
        await this.touchLibrary()
      },
    )
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
    await this.db.transaction(
      'rw',
      this.db.drugs,
      this.db.meta,
      this.db.revisions,
      async () => {
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
        for (const record of records) {
          await this.db.drugs.put(record)
          // Phase 20: a full-snapshot write advances every id's revision,
          // so any editor form still holding a pre-replacement token is
          // rejected instead of overwriting the replaced record.
          await this.bumpRevision(record.id)
        }
        await this.db.meta.clear()
        await this.db.meta.put(next.metadata)
      },
    )
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
    return this.db.transaction(
      'rw',
      this.db.drugs,
      this.db.meta,
      this.db.revisions,
      async () => {
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
            // Phase 20: every written id's revision advances, so an edit
            // form still open on a pre-import record is rejected instead
            // of overwriting the imported row.
            await this.bumpRevision(drug.id)
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
            // Phase 20: created AND updated ids advance their revision, so
            // every editor token issued before this import — including one
            // for an id the file re-creates after a delete — is rejected.
            await this.bumpRevision(drug.id)
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
      },
    )
  }

  async exportLibrary(): Promise<DrugLibrary> {
    const metadata = await this.getLibraryMetadata()
    const { drugs } = await this.getAllDrugs()
    // Quarantined records are unreadable and therefore not exported; they
    // remain in storage and visible in the quarantine report. The phase-20
    // revision token is stripped at this interchange boundary: it is
    // storage-local bookkeeping and never travels with the data.
    return { metadata, drugs: drugs.map(stripRevision) }
  }

  async exportRecoveryArchive(): Promise<RecoveryExportOutcome> {
    let snapshot: { drugs: RawSnapshotRow[]; meta: RawSnapshotRow[]; scenarios: RawSnapshotRow[] }
    try {
      // One read-only transaction over BOTH stores (docs/recovery-backup.md
      // §7): cursor callbacks capture the real IndexedDB primary key next
      // to each structured-cloned value, and both reads finish inside the
      // transaction before any CPU-heavy work (scanning, classification,
      // serialization) runs on the copies — so counts and entries can
      // never mix the pre- and post-write sides of a concurrent change.
      // No fallback path: a read failure is fail-closed BACKUP_READ_FAILED.
      snapshot = await this.db.transaction('r', this.db.drugs, this.db.meta, this.db.scenarios, async () => {
        const drugs: RawSnapshotRow[] = []
        await this.db.drugs.each((value, cursor) => {
          drugs.push({ key: cursor.primaryKey, value })
        })
        const meta: RawSnapshotRow[] = []
        await this.db.meta.each((value, cursor) => {
          meta.push({ key: cursor.primaryKey, value })
        })
        const scenarios: RawSnapshotRow[] = []
        await this.db.scenarios.each((value, cursor) => {
          scenarios.push({ key: cursor.primaryKey, value })
        })
        return { drugs, meta, scenarios }
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
      scenarios: snapshot.scenarios,
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
    // Phase 20: the revision table is NOT part of the archive format —
    // every restored id's local revision advances instead, so an editor
    // form still holding a pre-restore token is rejected rather than
    // silently overwriting restored data (ADR-21).
    await this.db.transaction(
      'rw',
      this.db.drugs,
      this.db.meta,
      this.db.revisions,
      // Phase 45: saved scenarios are replaced in the SAME transaction, so a
      // failure rolls back drugs, metadata and scenarios together.
      this.db.scenarios,
      async () => {
        await this.db.drugs.clear()
        await this.db.meta.clear()
        // An archive written before phase 45 has no scenarios: the store is
        // then emptied, consistently with the rest of the snapshot.
        await this.db.scenarios.clear()
        for (const row of parsed.archive.drugs) {
          await this.db.drugs.put(row.value as unknown as DrugRecord)
          // The id the write above used: the in-line `id` of the row
          // value (`put` derives the key from it; validation proved it
          // equals the entry key).
          await this.bumpRevision(recordKey(row.value))
        }
        for (const row of parsed.archive.meta) {
          await this.db.meta.put(row.value as unknown as LibraryMetadata)
        }
        for (const row of parsed.archive.scenarios) {
          await this.db.scenarios.put(row.value as unknown as SavedScenario)
        }
      },
    )
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

  /**
   * Current revision of one id (phase 20, ADR-21). Caller must be inside
   * a transaction that includes `revisions`. Absent row = 0: a record
   * never written under the token scheme (pre-v4 database, raw-seeded
   * fixture) reads as "never revised" — its first edit moves it to 1.
   */
  private async currentRevision(id: DrugId): Promise<number> {
    const entry: DrugRevision | undefined = await this.db.revisions.get(id)
    return entry?.revision ?? 0
  }

  /**
   * Advance one id's revision by exactly 1 inside the caller's open
   * transaction (phase 20, ADR-21) and return the new value. Every path
   * that writes a drug row calls this in the SAME read-write transaction
   * as the row write, so the token and the data commit atomically. The
   * sequence is strictly monotonic per id for the lifetime of the
   * database: deletions keep their tombstone and every re-creation
   * (create, import, replace, restore) continues above it, so a revision
   * an old edit token holds can never be issued again (no ABA replay
   * after delete → re-create).
   */
  private async bumpRevision(id: DrugId): Promise<number> {
    const next = (await this.currentRevision(id)) + 1
    await this.db.revisions.put({ id, revision: next })
    return next
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
