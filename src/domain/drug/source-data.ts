/**
 * Imported source-data snapshot attached to a drug record.
 *
 * Layer A (compound identity) and Layer B (experimental observations) live
 * in their own stores (`compounds` / `observations`) and are acquired on
 * demand. A drug record that was created from — or explicitly linked to — a
 * stored source record keeps a *typed snapshot* of that record here, so the
 * imported identity, chemical properties, attribution, license terms and
 * measurements stay readable even though the Layer A/B stores are a
 * separate, replaceable set of tables.
 *
 * Design rules encoded by this module:
 *
 * - **Structured, never prose.** Identifiers and chemical properties are
 *   typed fields (`CompoundIdentifiers`); the same information is never
 *   copied into `Drug.notes`. Notes stay user notes.
 * - **Separate from Layer C.** An imported observation is a *reported
 *   measurement*, not a model parameter. It is stored with its endpoint,
 *   value, unit, qualifier, target, species, assay and provenance, and it
 *   never fills `kd`/`ki`/`ec50`/`ic50` on its own — that only happens
 *   through the explicit "Use as parameter…" flow (`applyObservation`).
 * - **Identity is external, never the name.** A snapshot is keyed by the
 *   source's own adapter id + record id. At most one snapshot per exact
 *   `source` string, mirroring `TargetSourceReference` (ADR-20): a second
 *   record from the same source system with a *different* id is a conflict
 *   reported to the caller, never merged or overwritten. Different source
 *   systems may sit side by side.
 * - **Observations are linked by validated identity.** `observations`
 *   only ever holds records whose `compoundId` equals
 *   `${source}:${sourceId}` (enforced by the schema boundary); a
 *   display-name match alone never associates a measurement.
 * - **Missing stays missing.** Every optional field is omitted when the
 *   source did not supply it; nothing here is invented, defaulted or
 *   derived.
 * - **Disagreement is preserved.** Two measurements that contradict each
 *   other are both kept, as separate entries, in their original order.
 *
 * Pure domain module: no React, no I/O, no schema imports.
 */
import type { SourceAttribution } from '../sources/attribution'
import type { CompoundIdentifiers } from '../sources/compound'
import type { ExperimentalObservation } from '../sources/observation'

/**
 * One imported measurement, exactly as the Layer B store holds it.
 *
 * Deliberately the *same* type rather than a parallel shape: a measurement
 * has one vocabulary in this codebase, so a snapshot can never drift from
 * the stored record it was taken from (and an unknown field a future build
 * added to a stored observation travels with the snapshot unchanged).
 */
export type ImportedObservation = ExperimentalObservation

/**
 * Snapshot of one external source record as imported onto a drug record.
 *
 * `provenance` carries the source name, the record URL, the retrieval
 * timestamp, the source version (when supplied) and the licensing terms —
 * the attribution obligations travel with the data itself.
 */
export interface DrugSourceRecord {
  /** Adapter id that supplied the record (e.g. 'pubchem', 'chembl'). */
  readonly source: string
  /** Authoritative identifier within that source ('2244', 'CHEMBL25'). */
  readonly sourceId: string
  /** Preferred display name — absent when the source supplied none. */
  readonly name?: string
  /** All synonyms the source supplied, in its own order. */
  readonly synonyms: readonly string[]
  /** Structured identifiers and chemical properties (`CompoundIdentifiers`). */
  readonly identifiers: CompoundIdentifiers
  /** Source name, record URL, retrieval time, version and license terms. */
  readonly provenance: SourceAttribution
  /**
   * Measurements stored for exactly this external record (validated
   * identity link, never a name match). Empty when the compound has none.
   */
  readonly observations: readonly ImportedObservation[]
  /** When this snapshot was attached to the drug record (ISO 8601). */
  readonly importedAt: string
}

/** The snapshot this drug carries from `source`, if any. */
export function findSourceRecord(
  records: readonly DrugSourceRecord[] | undefined,
  source: string,
): DrugSourceRecord | undefined {
  return records?.find((record) => record.source === source)
}

/**
 * Attach `incoming` under the identity rules above:
 *
 * - no snapshot from that source yet → appended (a different source system
 *   never replaces another one);
 * - the same external record → the stored snapshot is kept and only
 *   observations whose `id` is not stored yet are appended, so repeated
 *   imports are idempotent and can never duplicate a measurement. Existing
 *   observations are never rewritten, reordered or dropped — two
 *   disagreeing measurements of the same endpoint stay side by side;
 * - a CONFLICT (same source, different `sourceId`) is never merged or
 *   overwritten: the list is returned unchanged and the stored conflicting
 *   snapshot is reported so the caller handles it explicitly.
 */
export function mergeSourceRecord(
  existing: readonly DrugSourceRecord[] | undefined,
  incoming: DrugSourceRecord,
): {
  readonly records: readonly DrugSourceRecord[]
  readonly conflict?: DrugSourceRecord
  readonly addedObservations: number
} {
  const current = existing ?? []
  const same = findSourceRecord(current, incoming.source)
  if (same === undefined) {
    return { records: [...current, incoming], addedObservations: incoming.observations.length }
  }
  if (same.sourceId !== incoming.sourceId) {
    return { records: current, conflict: same, addedObservations: 0 }
  }
  const known = new Set(same.observations.map((observation) => observation.id))
  const added = incoming.observations.filter((observation) => !known.has(observation.id))
  if (added.length === 0) return { records: current, addedObservations: 0 }
  return {
    records: current.map((record) =>
      record === same ? { ...record, observations: [...record.observations, ...added] } : record,
    ),
    addedObservations: added.length,
  }
}

/**
 * The external identity string of a snapshot (`${source}:${sourceId}`),
 * the same deterministic form `compoundId` produces for a Layer A record.
 */
export function sourceRecordIdentity(record: {
  readonly source: string
  readonly sourceId: string
}): string {
  return `${record.source}:${record.sourceId}`
}
