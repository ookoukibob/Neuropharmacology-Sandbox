/**
 * Dexie implementation of the source-data repository (Layer A + Layer B).
 *
 * The import runs inside ONE `rw` transaction over both tables:
 *
 * 1. schema-validate every incoming record (the repository boundary —
 *    previews are advisory only);
 * 2. classify against stored rows: existing ids are never overwritten
 *    (they win and are reported as skipped), and an observation whose
 *    compound is neither imported nor stored is rejected as an orphan;
 * 3. write only the new rows.
 *
 * Steps 1–2 return before any write when something is wrong, so a
 * rejection leaves the tables byte-identical; a storage failure throws
 * out of the transaction and Dexie rolls back — there is no partial
 * import in either direction.
 */
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'
import type { SandboxDatabase } from '../db/database'
import { parseCompoundRecord, parseObservationRecord } from '../schemas/sources'
import type {
  SourceDataRepository,
  SourceImportIssue,
  SourceImportReport,
  SourceImportRequest,
  SourceLoadResult,
} from './sourceDataRepository'
import type { QuarantinedRecord } from './repository'

function recordKey(raw: unknown): string {
  if (typeof raw === 'object' && raw !== null) {
    const id = (raw as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return '(missing id)'
}

function hydrate<T>(
  raws: readonly unknown[],
  parse: (raw: unknown) => { readonly ok: true; readonly record: T } | { readonly ok: false; readonly errors: readonly string[] },
): SourceLoadResult<T> {
  const records: T[] = []
  const quarantine: QuarantinedRecord[] = []
  for (const raw of raws) {
    const result = parse(raw)
    if (result.ok) {
      records.push(result.record)
    } else {
      // Kept exactly as stored — reported, never repaired or deleted by
      // a read path (the established quarantine rule).
      quarantine.push({ id: recordKey(raw), errors: result.errors, record: raw })
    }
  }
  return { records, quarantine }
}

/** First occurrence wins; later duplicates are counted, never written. */
function dedupe<T extends { readonly id: string }>(records: readonly T[]): {
  readonly unique: readonly T[]
  readonly duplicates: number
} {
  const seen = new Set<string>()
  const unique: T[] = []
  let duplicates = 0
  for (const record of records) {
    if (seen.has(record.id)) {
      duplicates += 1
      continue
    }
    seen.add(record.id)
    unique.push(record)
  }
  return { unique, duplicates }
}

export class DexieSourceDataRepository implements SourceDataRepository {
  private readonly db: SandboxDatabase

  constructor(db: SandboxDatabase) {
    this.db = db
  }

  async listCompounds(): Promise<SourceLoadResult<Compound>> {
    const raws: unknown[] = await this.db.compounds.toArray()
    return hydrate(raws, parseCompoundRecord)
  }

  async listObservations(
    filter?: { readonly compoundId?: string },
  ): Promise<SourceLoadResult<ExperimentalObservation>> {
    const raws: unknown[] =
      filter?.compoundId !== undefined
        ? await this.db.observations.where('compoundId').equals(filter.compoundId).toArray()
        : await this.db.observations.toArray()
    return hydrate(raws, parseObservationRecord)
  }

  async importSourceRecords(request: SourceImportRequest): Promise<SourceImportReport> {
    return await this.db.transaction('rw', this.db.compounds, this.db.observations, async () => {
      const errors: SourceImportIssue[] = []

      // Step 1 — schema validation of every incoming record. The parse
      // results are reused below (no double validation).
      const parsedCompounds: Compound[] = []
      request.compounds.forEach((candidate, index) => {
        const result = parseCompoundRecord(candidate)
        if (result.ok) {
          parsedCompounds.push(result.record)
        } else {
          errors.push({
            code: 'INVALID_RECORD',
            path: `compounds.${index}`,
            message: result.errors.join('; '),
          })
        }
      })
      const parsedObservations: ExperimentalObservation[] = []
      request.observations.forEach((candidate, index) => {
        const result = parseObservationRecord(candidate)
        if (result.ok) {
          parsedObservations.push(result.record)
        } else {
          errors.push({
            code: 'INVALID_RECORD',
            path: `observations.${index}`,
            message: result.errors.join('; '),
          })
        }
      })

      // Step 2 — classify against stored rows, still read-only.
      const compoundIds = parsedCompounds.map((compound) => compound.id)
      const storedCompounds = await this.db.compounds.bulkGet(compoundIds)
      const existingCompoundIds = new Set(
        compoundIds.filter((_id, index) => storedCompounds[index] !== undefined),
      )
      // Observations may reference compounds that are NOT part of this
      // batch — look up exactly those (and only those) in storage.
      const batchCompoundIds = new Set(compoundIds)
      const referencedOnly = [
        ...new Set(
          parsedObservations.map((observation) => observation.compoundId),
        ),
      ].filter((id) => !batchCompoundIds.has(id))
      const referencedRows = await this.db.compounds.bulkGet(referencedOnly)
      const storedCompoundIds = new Set(
        referencedOnly.filter((_id, index) => referencedRows[index] !== undefined),
      )
      parsedObservations.forEach((observation, index) => {
        if (batchCompoundIds.has(observation.compoundId)) return
        if (storedCompoundIds.has(observation.compoundId)) return
        errors.push({
          code: 'ORPHAN_OBSERVATION',
          path: `observations.${index}`,
          message: `compound "${observation.compoundId}" is neither part of this import nor already stored; the observation cannot be imported without its compound`,
        })
      })
      const observationIds = parsedObservations.map((observation) => observation.id)
      const storedObservations = await this.db.observations.bulkGet(observationIds)
      const existingObservationIds = new Set(
        observationIds.filter((_id, index) => storedObservations[index] !== undefined),
      )

      if (errors.length > 0) {
        // Rejected before the first write — the tables stay untouched.
        return { ok: false, errors }
      }

      // Step 3 — write only what does not exist yet. Existing rows win
      // (no overwrite of stored records) and duplicates inside the batch
      // collapse onto their first occurrence.
      const compounds = dedupe(parsedCompounds)
      const observations = dedupe(parsedObservations)
      const newCompounds = compounds.unique.filter(
        (compound) => !existingCompoundIds.has(compound.id),
      )
      const newObservations = observations.unique.filter(
        (observation) => !existingObservationIds.has(observation.id),
      )
      await this.db.compounds.bulkAdd(newCompounds)
      await this.db.observations.bulkAdd(newObservations)

      return {
        ok: true,
        createdCompounds: newCompounds.length,
        createdObservations: newObservations.length,
        skippedCompounds:
          compounds.unique.length - newCompounds.length + compounds.duplicates,
        skippedObservations:
          observations.unique.length - newObservations.length + observations.duplicates,
      }
    })
  }
}
