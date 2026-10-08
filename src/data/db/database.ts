/**
 * Single versioned IndexedDB module (ADR-14).
 *
 * One Dexie database, two declared schema versions — there is exactly one
 * place that knows the storage schema:
 *
 * - v1 (initial): `drugs` keyed by `id`, `meta` keyed by `id`.
 * - v2 (current): adds `origin` and `updatedAt` indexes on `drugs` for
 *   library queries, plus an idempotent upgrade hook that backfills
 *   bookkeeping only:
 *     - `persistenceVersion` (the record-shape contract, see records.ts),
 *     - missing `createdAt`/`updatedAt` bookkeeping timestamps.
 *   The hook never creates, rewrites or deletes scientific fields or
 *   unknown (future) fields — `modify` only adds the two bookkeeping keys
 *   when absent, so data written by a v1 build survives verbatim.
 *
 * React, the engine and domain modules never import this file; only the
 * repository implementation does.
 */
import Dexie, { type EntityTable } from 'dexie'
import type { LibraryMetadata } from '../../domain/library/library'
import { PERSISTENCE_VERSION, type DrugRecord } from '../mappers/records'

export const DATABASE_NAME = 'neuropharmacology-sandbox'

export class SandboxDatabase extends Dexie {
  drugs!: EntityTable<DrugRecord, 'id'>
  meta!: EntityTable<LibraryMetadata, 'id'>

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
  }
}
