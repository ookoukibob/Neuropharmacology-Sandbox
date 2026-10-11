/**
 * Dexie implementation of the source-data repository (Layer A + Layer B).
 *
 * The import runs inside ONE `rw` transaction over both tables:
 *
 * 1. validate every incoming record (the repository boundary — previews
 *    are advisory only): schema shape plus the cross-field identity
 *    invariants derived from the deterministic id factories;
 * 2. classify against stored rows, using the SAME authoritative parser
 *    hydration uses: an existing VALID id is never overwritten (it wins
 *    and is reported as skipped), an id that collides with a stored row
 *    failing validation is a blocking `QUARANTINE_CONFLICT`, and an
 *    observation whose compound is neither imported nor stored validly is
 *    rejected (orphan, or quarantine conflict when the referenced row is
 *    malformed);
 * 3. write only the new rows.
 *
 * Steps 1–2 return before any write when something is wrong, so a
 * rejection leaves the tables byte-identical — quarantined rows are never
 * overwritten, repaired, deleted or silently skipped; a storage failure
 * throws out of the transaction and Dexie rolls back — there is no
 * partial import in either direction.
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

/**
 * Blocking conflict for an id colliding with (or referencing) a stored
 * row that fails the authoritative source-record validator. Mirrors the
 * drug repository's merge-vs-quarantined-row policy (audit GAP-3,
 * `dexieDrugRepository.ts`): protection wins — the whole import is
 * rejected before any write and the quarantined row is preserved
 * byte-identical, never silently skipped as an ordinary duplicate.
 */
function quarantineConflict(
  table: 'compounds' | 'observations',
  requestIndex: number,
  id: string,
): SourceImportIssue {
  return {
    code: 'QUARANTINE_CONFLICT',
    path: `${table}.${requestIndex}`,
    message: `stored record "${id}" fails source-record validation and is quarantined; the whole import was rejected and the quarantined record was preserved unchanged, with nothing from this request written. Resolve the quarantine conflict for "${id}" before importing this id.`,
  }
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

      // Step 1 — validation of every incoming record (schema + identity).
      // Parse results keep their request index so later issues point at
      // the exact record; they are reused below (no double validation).
      const parsedCompounds: { readonly record: Compound; readonly index: number }[] = []
      request.compounds.forEach((candidate, index) => {
        const result = parseCompoundRecord(candidate)
        if (result.ok) {
          parsedCompounds.push({ record: result.record, index })
        } else {
          errors.push({
            code: 'INVALID_RECORD',
            path: `compounds.${index}`,
            message: result.errors.join('; '),
          })
        }
      })
      const parsedObservations: {
        readonly record: ExperimentalObservation
        readonly index: number
      }[] = []
      request.observations.forEach((candidate, index) => {
        const result = parseObservationRecord(candidate)
        if (result.ok) {
          parsedObservations.push({ record: result.record, index })
        } else {
          errors.push({
            code: 'INVALID_RECORD',
            path: `observations.${index}`,
            message: result.errors.join('; '),
          })
        }
      })

      // Step 2 — classify against stored rows, still read-only. A
      // colliding id only counts as a normal duplicate when the STORED
      // row passes the authoritative validator (the same parser hydration
      // uses): a malformed stored row is quarantined and must never be
      // silently skipped — the whole import is rejected instead.
      const compoundIds = parsedCompounds.map((entry) => entry.record.id)
      const storedCompounds = await this.db.compounds.bulkGet(compoundIds)
      const existingCompoundIds = new Set<string>()
      compoundIds.forEach((id, index) => {
        const raw = storedCompounds[index]
        if (raw === undefined) return
        if (!parseCompoundRecord(raw).ok) {
          errors.push(
            quarantineConflict('compounds', parsedCompounds[index]?.index ?? index, id),
          )
          return
        }
        existingCompoundIds.add(id)
      })

      // Observations may reference compounds that are NOT part of this
      // batch — look up exactly those (and only those) in storage. A
      // stored row that fails validation does not count as the compound:
      // a measurement is never imported as valid against a malformed row.
      const batchCompoundIds = new Set(compoundIds)
      const referencedOnly = [
        ...new Set(parsedObservations.map((entry) => entry.record.compoundId)),
      ].filter((id) => !batchCompoundIds.has(id))
      const referencedRows = await this.db.compounds.bulkGet(referencedOnly)
      const storedCompoundIds = new Set<string>()
      const quarantinedCompoundIds = new Set<string>()
      referencedOnly.forEach((id, index) => {
        const raw = referencedRows[index]
        if (raw === undefined) return
        if (!parseCompoundRecord(raw).ok) {
          quarantinedCompoundIds.add(id)
          return
        }
        storedCompoundIds.add(id)
      })
      parsedObservations.forEach((entry) => {
        const observation = entry.record
        if (batchCompoundIds.has(observation.compoundId)) return
        if (storedCompoundIds.has(observation.compoundId)) return
        if (quarantinedCompoundIds.has(observation.compoundId)) {
          errors.push({
            code: 'QUARANTINE_CONFLICT',
            path: `observations.${entry.index}`,
            message: `compound "${observation.compoundId}" exists only as a stored row that fails source-record validation (quarantined); an observation is never imported as valid against it. The whole import was rejected and the quarantined row was left unchanged, with nothing from this request written. Resolve the quarantine conflict for "${observation.compoundId}" first.`,
          })
          return
        }
        errors.push({
          code: 'ORPHAN_OBSERVATION',
          path: `observations.${entry.index}`,
          message: `compound "${observation.compoundId}" is neither part of this import nor already stored; the observation cannot be imported without its compound`,
        })
      })
      const observationIds = parsedObservations.map((entry) => entry.record.id)
      const storedObservations = await this.db.observations.bulkGet(observationIds)
      const existingObservationIds = new Set<string>()
      observationIds.forEach((id, index) => {
        const raw = storedObservations[index]
        if (raw === undefined) return
        if (!parseObservationRecord(raw).ok) {
          errors.push(
            quarantineConflict('observations', parsedObservations[index]?.index ?? index, id),
          )
          return
        }
        existingObservationIds.add(id)
      })

      if (errors.length > 0) {
        // Rejected before the first write — the tables stay untouched.
        return { ok: false, errors }
      }

      // Step 3 — write only what does not exist yet. Existing VALID rows
      // win (no overwrite of stored records) and duplicates inside the
      // batch collapse onto their first occurrence.
      const compounds = dedupe(parsedCompounds.map((entry) => entry.record))
      const observations = dedupe(parsedObservations.map((entry) => entry.record))
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
