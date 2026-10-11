/**
 * Single versioned IndexedDB module (ADR-14).
 *
 * One Dexie database, three declared schema versions — there is exactly one
 * place that knows the storage schema:
 *
 * - v1 (initial): `drugs` keyed by `id`, `meta` keyed by `id`.
 * - v2: adds `origin` and `updatedAt` indexes on `drugs` for
 *   library queries, plus an idempotent upgrade hook that backfills
 *   bookkeeping only:
 *     - `persistenceVersion` (the record-shape contract, see records.ts),
 *     - missing `createdAt`/`updatedAt` bookkeeping timestamps.
 *   The hook never creates, rewrites or deletes scientific fields or
 *   unknown (future) fields — `modify` only adds the two bookkeeping keys
 *   when absent, so data written by a v1 build survives verbatim.
 * - v3: adds the on-demand source-data tables — `compounds`
 *   (Layer A, keyed by `${source}:${sourceId}`) and `observations`
 *   (Layer B, keyed by `${source}:${recordId}` with a `compoundId`
 *   index). Purely additive: no existing table, index, record or
 *   bookkeeping field is touched, and opening an existing database never
 *   fetches anything — these tables are only written by an explicit,
 *   confirmed import.
 * - v4 (current): adds the `revisions` table (phase 20, audit GAP-4) —
 *   one monotonic per-record revision number per drug id, the optimistic
 *   concurrency token compared *inside* the same read-write transaction
 *   as the record write (ADR-21). Purely additive like v3: drug rows are
 *   untouched and the revision deliberately lives OUTSIDE the record, so
 *   every row-level contract (byte-identical restore, unknown-field
 *   preservation, `.npsb` archives, NPSL interchange) is unaffected.
 *
 * React, the engine and domain modules never import this file; only the
 * repository implementations do.
 */
import Dexie, { type EntityTable } from 'dexie'
import type { LibraryMetadata } from '../../domain/library/library'
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'
import { PERSISTENCE_VERSION, type DrugRecord, type DrugRevision } from '../mappers/records'

export const DATABASE_NAME = 'neuropharmacology-sandbox'

export class SandboxDatabase extends Dexie {
  drugs!: EntityTable<DrugRecord, 'id'>
  meta!: EntityTable<LibraryMetadata, 'id'>
  /** Layer A — compound identity acquired on demand (never seeded). */
  compounds!: EntityTable<Compound, 'id'>
  /** Layer B — experimental observations acquired on demand (never seeded). */
  observations!: EntityTable<ExperimentalObservation, 'id'>
  /**
   * Optimistic-concurrency tokens (phase 20, ADR-21): one monotonic
   * revision number per drug id. Never part of a drug record, an NPSL
   * document or a `.npsb` archive — storage-local bookkeeping like
   * `persistenceVersion`, but stored beside the row instead of inside it.
   */
  revisions!: EntityTable<DrugRevision, 'id'>

  constructor(name: string = DATABASE_NAME) {
    super(name)

    this.version(1).stores({
      drugs: 'id',
      meta: 'id',
    })

    this.version(2)
      .stores({
        drugs: 'id, origin, updatedAt',
        meta: 'id',
      })
      .upgrade(async (tx) => {
        // Bookkeeping backfill only — never touches scientific or unknown
        // fields (the migration demo in database.test.ts proves it).
        await tx
          .table('drugs')
          .toCollection()
          .modify((record: Record<string, unknown>) => {
            if (record['persistenceVersion'] === undefined) {
              record['persistenceVersion'] = PERSISTENCE_VERSION
            }
            const created = record['createdAt']
            const updated = record['updatedAt']
            if (typeof created !== 'string' || typeof updated !== 'string') {
              const stamp =
                typeof created === 'string'
                  ? created
                  : typeof updated === 'string'
                    ? updated
                    : new Date().toISOString()
              if (typeof created !== 'string') record['createdAt'] = stamp
              if (typeof updated !== 'string') record['updatedAt'] = stamp
            }
          })
      })

    // Additive v3: two new tables, no upgrade hook — existing rows and
    // the v2 indexes are declared unchanged (see the header contract).
    this.version(3).stores({
      drugs: 'id, origin, updatedAt',
      meta: 'id',
      compounds: 'id',
      observations: 'id, compoundId',
    })

    // Additive v4 (phase 20): the per-record revision table, no upgrade
    // hook — an existing database opens with an empty revisions store and
    // every pre-existing drug row reads as revision 0 ("never edited
    // under the token scheme"), which the migration test pins.
    this.version(4).stores({
      drugs: 'id, origin, updatedAt',
      meta: 'id',
      compounds: 'id',
      observations: 'id, compoundId',
      revisions: 'id',
    })
  }
}
