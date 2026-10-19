/**
 * Persistence DTO and mappers (ADR-14).
 *
 * Explicit persistence-DTO vs domain decision:
 * - The domain `Drug` is the in-memory scientific view used by features and
 *   the engine. The persistence record is the storage shape: the domain
 *   shape plus `persistenceVersion` bookkeeping. They are intentionally
 *   close (small repository, clear 1:1 mapping) but never identical by
 *   accident — every crossing goes through `toRecord` / `fromRecord`.
 * - `fromRecord` validates raw stored data against the NPSL `drugSchema`
 *   (the one schema for NPSL files and IndexedDB records) and returns a
 *   result instead of throwing, so invalid records can be quarantined and
 *   reported on hydration — never silently dropped or repaired.
 * - Unknown keys at any nesting level (fields from future schema minor
 *   versions) are carried forward by `toStoredRecord` using the documented
 *   DTO key sets below: a key *in* the contract is governed by the domain
 *   value (clearing a field deletes it), a key *outside* the contract is
 *   copied forward from its source — the incoming domain drug first (a
 *   freshly imported record carries its file's extensions), then the
 *   previous record (storage-only extensions survive an edit or a merge
 *   that never mentioned them). Because a source only fills keys the new
 *   record does not already have, an incoming extension wins a key
 *   collision deterministically — the documented Merge policy. Schema
 *   migrations (the Dexie upgrade hook) only ever add bookkeeping keys —
 *   they never rewrite scientific or unknown fields.
 * - Provenance triples ({ value, unit, provenance }) are stored whole and
 *   never flattened; provenance is never created, upgraded or rewritten by
 *   this layer.
 */
import type {
  Drug,
  DrugId,
  DrugOrigin,
  Pharmacokinetics,
  ReceptorTarget,
  TargetSourceReference,
} from '../../domain/drug/drug'
import type { DrugSourceRecord, ImportedObservation } from '../../domain/drug/source-data'
import type { CompoundIdentifiers } from '../../domain/sources/compound'
import type { SourceAttribution } from '../../domain/sources/attribution'
import type {
  ObservationAssay,
  ObservationReference,
  ObservationTargetRef,
} from '../../domain/sources/observation'
import type { LibraryMetadata } from '../../domain/library/library'
import type {
  MaybeScientificValue,
  ScientificValue,
} from '../../domain/pharmacology/scientific-value'
import { drugSchema } from '../schemas/npsl'

/**
 * Record-shape version written by this build for drug records. The drug
 * record contract has not changed since schema v2, so this stays at 2 and
 * the 1 -> 2 upgrade keeps backfilling it on legacy records; the Dexie
 * database schema has since gained purely additive source-data tables
 * (see database.ts v3), which are versioned by the database schema
 * rather than by this field.
 */
export const PERSISTENCE_VERSION = 2

/**
 * The stored form of a drug record: domain shape + persistence bookkeeping.
 * A type alias (not an interface) so it satisfies `Record<string, unknown>`
 * for the unknown-field merge helpers without casts.
 */
export type DrugRecord = {
  id: DrugId
  origin: DrugOrigin
  identifiers: {
    name: string
    synonyms: readonly string[]
    description?: string
    casNumber?: string
  }
  tags: readonly string[]
  targets: readonly ReceptorTarget[]
  pharmacokinetics: Pharmacokinetics
  notes?: string
  /**
   * Imported source-data snapshots (phase 36) — a known field owned by the
   * mapper, never left to unknown-field preservation. Absent when the
   * record carries none (never written as an empty array).
   */
  sourceRecords?: readonly DrugSourceRecord[]
  createdAt?: string
  updatedAt?: string
  persistenceVersion: number
}

/**
 * Optimistic-concurrency token row (phase 20, ADR-21): the current
 * revision number of one drug id, stored BESIDE the record (Dexie v4
 * `revisions` table) so drug rows stay byte-identical for every existing
 * contract. `updateDrug` compares the caller's expected revision against
 * this row inside the same read-write transaction as the record write;
 * every path that writes a drug row bumps it. Never serialized into NPSL
 * or `.npsb` interchange.
 */
export type DrugRevision = {
  id: DrugId
  /** Strictly monotonic per id (delete keeps the tombstone; absent = 0). */
  revision: number
}

/**
 * The DTO key contract — the documented field set of each record level.
 * Anything not listed here is an unknown (future) field and is preserved
 * verbatim across edits; anything listed is owned by the domain value.
 * `revision` is listed but never written by the mapper: the token lives
 * in the separate `revisions` table (phase 20, ADR-21), and listing it
 * here makes unknown-field preservation treat any stray copy — a
 * hand-edited row or a file carrying a `revision` key — as record-layer
 * bookkeeping to drop, never to carry forward into storage.
 */
const ROOT_KEYS = new Set([
  'id',
  'origin',
  'identifiers',
  'tags',
  'targets',
  'pharmacokinetics',
  'notes',
  'sourceRecords',
  'createdAt',
  'updatedAt',
  'persistenceVersion',
  'revision',
])
const IDENTIFIER_KEYS = new Set(['name', 'synonyms', 'description', 'casNumber'])
const TARGET_KEYS = new Set([
  'id',
  'name',
  'gene',
  'action',
  'species',
  'kd',
  'ki',
  'ec50',
  'ic50',
  'notes',
  'sourceReferences',
])
const REFERENCE_KEYS = new Set([
  'source',
  'sourceName',
  'sourceTargetId',
  'name',
  'organism',
  'url',
  'licenseNotice',
  'licenseUrl',
])
const PARAMETER_KEYS = new Set(['value', 'unit', 'provenance'])
const PROVENANCE_KEYS = new Set([
  // union of all five provenance variants — a variant-specific key that is
  // "known" for one type is treated as known for all, so a provenance swap
  // can never strand a sibling variant's field.
  'type',
  'source',
  'citation',
  'doi',
  'url',
  'accessedAt',
  'sourceRecordId',
  'licenseNotice',
  'licenseUrl',
  'observationId',
  'recordedAt',
  'model',
  'method',
  'from',
  'notes',
])
const PK_KEYS = new Set([
  'halfLife',
  'clearance',
  'volumeOfDistribution',
  'bioavailability',
  'notes',
])
/**
 * Imported source-data snapshot (phase 36). The snapshot is a *copy* of a
 * Layer A/B record, so its own key contract mirrors the source schemas in
 * `data/schemas/sources.ts` — a key listed there is governed by the domain
 * value, anything else is a future field carried forward verbatim.
 */
const SOURCE_RECORD_KEYS = new Set([
  'source',
  'sourceId',
  'name',
  'synonyms',
  'identifiers',
  'provenance',
  'observations',
  'importedAt',
])
const COMPOUND_IDENTIFIER_KEYS = new Set([
  'pubchemCid',
  'chemblId',
  'inchiKey',
  'smiles',
  'molecularFormula',
  'molecularWeight',
  'casNumber',
])
const SOURCE_ATTRIBUTION_KEYS = new Set([
  'source',
  'sourceName',
  'recordId',
  'url',
  'retrievedAt',
  'sourceVersion',
  'licenseNotice',
  'licenseUrl',
])
const OBSERVATION_KEYS = new Set([
  'id',
  'compoundId',
  'compoundSourceId',
  'compoundName',
  'target',
  'endpoint',
  'parameterKind',
  'value',
  'unit',
  'qualifier',
  'rawRelation',
  'species',
  'assay',
  'reference',
  'activityComment',
  'dataValidityNote',
  'provenance',
  'createdAt',
  'updatedAt',
])
const OBSERVATION_TARGET_KEYS = new Set([
  'name',
  'sourceTargetId',
  'sourceTargetUrl',
  'organism',
])
const OBSERVATION_ASSAY_KEYS = new Set(['assayId', 'assayType', 'description'])
const OBSERVATION_REFERENCE_KEYS = new Set(['referenceId', 'journal', 'year'])

type Level =
  | 'root'
  | 'identifiers'
  | 'target'
  | 'reference'
  | 'parameter'
  | 'provenance'
  | 'pharmacokinetics'
  | 'sourceRecord'
  | 'compoundIdentifiers'
  | 'sourceAttribution'
  | 'observation'
  | 'observationTarget'
  | 'observationAssay'
  | 'observationReference'

function keysOf(level: Level): Set<string> {
  switch (level) {
    case 'root':
      return ROOT_KEYS
    case 'identifiers':
      return IDENTIFIER_KEYS
    case 'target':
      return TARGET_KEYS
    case 'reference':
      return REFERENCE_KEYS
    case 'parameter':
      return PARAMETER_KEYS
    case 'provenance':
      return PROVENANCE_KEYS
    case 'pharmacokinetics':
      return PK_KEYS
    case 'sourceRecord':
      return SOURCE_RECORD_KEYS
    case 'compoundIdentifiers':
      return COMPOUND_IDENTIFIER_KEYS
    case 'sourceAttribution':
      return SOURCE_ATTRIBUTION_KEYS
    case 'observation':
      return OBSERVATION_KEYS
    case 'observationTarget':
      return OBSERVATION_TARGET_KEYS
    case 'observationAssay':
      return OBSERVATION_ASSAY_KEYS
    case 'observationReference':
      return OBSERVATION_REFERENCE_KEYS
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Child level for a known key, or null when the value is a leaf/array. */
function childLevel(level: Level, key: string): Level | null {
  if (level === 'root' && key === 'identifiers') return 'identifiers'
  if (level === 'root' && key === 'pharmacokinetics') return 'pharmacokinetics'
  if (level === 'target' && (key === 'kd' || key === 'ki' || key === 'ec50' || key === 'ic50')) {
    return 'parameter'
  }
  if (level === 'pharmacokinetics' && key !== 'notes') return 'parameter'
  if (level === 'parameter' && key === 'provenance') return 'provenance'
  // Phase 36 — imported source-data snapshot, level by level.
  if (level === 'sourceRecord' && key === 'identifiers') return 'compoundIdentifiers'
  if (level === 'sourceRecord' && key === 'provenance') return 'sourceAttribution'
  if (level === 'observation' && key === 'target') return 'observationTarget'
  if (level === 'observation' && key === 'assay') return 'observationAssay'
  if (level === 'observation' && key === 'reference') return 'observationReference'
  if (level === 'observation' && key === 'provenance') return 'sourceAttribution'
  return null
}

/**
 * Copy unknown (out-of-contract) fields from a source object into the
 * rewritten record, level by level. Contract keys are never copied — the
 * new value governs, so a cleared field stays cleared. Nested objects
 * recurse through their level's key set; `targets` elements are matched by
 * stable id (not position), so re-ordering or removing rows cannot
 * transplant unknown fields onto the wrong target.
 *
 * `previous` is only ever read (any object source: the incoming drug or
 * the stored record); `next` is written. A source fills a key only when
 * `next` does not have it yet — callers therefore control priority by
 * calling in order (see `toStoredRecord`).
 */
export function preserveUnknownFields(
  previous: object,
  next: Record<string, unknown>,
  level: Level = 'root',
): void {
  const source = previous as Record<string, unknown>
  const known = keysOf(level)
  for (const key of Object.keys(source)) {
    const prevValue = source[key]
    if (!known.has(key)) {
      // Unknown at this level: a future field the current build does not
      // understand — carry it forward untouched.
      if (!(key in next)) next[key] = prevValue
      continue
    }
    const nextValue = next[key]
    const child = childLevel(level, key)
    if (child !== null && isPlainObject(prevValue) && isPlainObject(nextValue)) {
      preserveUnknownFields(prevValue, nextValue, child)
    } else if (key === 'targets' && Array.isArray(prevValue) && Array.isArray(nextValue)) {
      for (const nextTarget of nextValue) {
        if (!isPlainObject(nextTarget)) continue
        const id = nextTarget['id']
        if (typeof id !== 'string') continue
        const prevTarget = prevValue.find(
          (candidate) => isPlainObject(candidate) && candidate['id'] === id,
        )
        if (isPlainObject(prevTarget)) {
          preserveUnknownFields(prevTarget, nextTarget, 'target')
        }
      }
    } else if (
      key === 'sourceRecords' &&
      level === 'root' &&
      Array.isArray(prevValue) &&
      Array.isArray(nextValue)
    ) {
      // Snapshots are matched by their external identity — the exact source
      // string (at most one snapshot per source) — never array position.
      for (const nextRecord of nextValue) {
        if (!isPlainObject(nextRecord)) continue
        const source = nextRecord['source']
        if (typeof source !== 'string') continue
        const prevRecord = prevValue.find(
          (candidate) => isPlainObject(candidate) && candidate['source'] === source,
        )
        if (isPlainObject(prevRecord)) {
          preserveUnknownFields(prevRecord, nextRecord, 'sourceRecord')
        }
      }
    } else if (
      level === 'sourceRecord' &&
      key === 'observations' &&
      Array.isArray(prevValue) &&
      Array.isArray(nextValue)
    ) {
      // Measurements are matched by their deterministic source record id —
      // never by position, endpoint or value — so an appended or reordered
      // list can never transplant an unknown field onto the wrong record.
      for (const nextObservation of nextValue) {
        if (!isPlainObject(nextObservation)) continue
        const id = nextObservation['id']
        if (typeof id !== 'string') continue
        const prevObservation = prevValue.find(
          (candidate) => isPlainObject(candidate) && candidate['id'] === id,
        )
        if (isPlainObject(prevObservation)) {
          preserveUnknownFields(prevObservation, nextObservation, 'observation')
        }
      }
    } else if (
      key === 'sourceReferences' &&
      Array.isArray(prevValue) &&
      Array.isArray(nextValue)
    ) {
      // References are matched by their stable identity — the source id
      // (at most one reference per source), never array position — so a
      // reordered or extended list can never transplant unknown fields
      // onto the wrong source's reference.
      for (const nextRef of nextValue) {
        if (!isPlainObject(nextRef)) continue
        const source = nextRef['source']
        if (typeof source !== 'string') continue
        const prevRef = prevValue.find(
          (candidate) => isPlainObject(candidate) && candidate['source'] === source,
        )
        if (isPlainObject(prevRef)) {
          preserveUnknownFields(prevRef, nextRef, 'reference')
        }
      }
    }
  }
}

function parameterToRecord(value: MaybeScientificValue): ScientificValue | undefined {
  if (value === undefined) return undefined
  return { value: value.value, unit: value.unit, provenance: value.provenance }
}

function referenceToRecord(reference: TargetSourceReference): TargetSourceReference {
  return {
    source: reference.source,
    sourceName: reference.sourceName,
    sourceTargetId: reference.sourceTargetId,
    ...(reference.name !== undefined ? { name: reference.name } : {}),
    ...(reference.organism !== undefined ? { organism: reference.organism } : {}),
    ...(reference.url !== undefined ? { url: reference.url } : {}),
    ...(reference.licenseNotice !== undefined ? { licenseNotice: reference.licenseNotice } : {}),
    ...(reference.licenseUrl !== undefined ? { licenseUrl: reference.licenseUrl } : {}),
  }
}

function targetToRecord(target: ReceptorTarget): ReceptorTarget {
  // Absent optionals are omitted, never written as `undefined` (see toRecord).
  return {
    id: target.id,
    name: target.name,
    ...(target.gene !== undefined ? { gene: target.gene } : {}),
    ...(target.action !== undefined ? { action: target.action } : {}),
    ...(target.species !== undefined ? { species: target.species } : {}),
    ...(target.kd !== undefined ? { kd: parameterToRecord(target.kd) } : {}),
    ...(target.ki !== undefined ? { ki: parameterToRecord(target.ki) } : {}),
    ...(target.ec50 !== undefined ? { ec50: parameterToRecord(target.ec50) } : {}),
    ...(target.ic50 !== undefined ? { ic50: parameterToRecord(target.ic50) } : {}),
    ...(target.notes !== undefined ? { notes: target.notes } : {}),
    // Phase 18I: source identities are a known domain field now — the
    // mapper, not unknown-field preservation, owns writing them. An
    // empty list stays absent (never written as `[]`).
    ...(target.sourceReferences !== undefined && target.sourceReferences.length > 0
      ? { sourceReferences: target.sourceReferences.map(referenceToRecord) }
      : {}),
  }
}

/** Absent optionals are omitted, never written as `undefined`. */
function sourceAttributionToRecord(attribution: SourceAttribution): SourceAttribution {
  return {
    source: attribution.source,
    sourceName: attribution.sourceName,
    recordId: attribution.recordId,
    url: attribution.url,
    retrievedAt: attribution.retrievedAt,
    ...(attribution.sourceVersion !== undefined ? { sourceVersion: attribution.sourceVersion } : {}),
    ...(attribution.licenseNotice !== undefined ? { licenseNotice: attribution.licenseNotice } : {}),
    ...(attribution.licenseUrl !== undefined ? { licenseUrl: attribution.licenseUrl } : {}),
  }
}

/** Compound identifiers/properties, verbatim — no value is ever coerced. */
function compoundIdentifiersToRecord(identifiers: CompoundIdentifiers): CompoundIdentifiers {
  return {
    ...(identifiers.pubchemCid !== undefined ? { pubchemCid: identifiers.pubchemCid } : {}),
    ...(identifiers.chemblId !== undefined ? { chemblId: identifiers.chemblId } : {}),
    ...(identifiers.inchiKey !== undefined ? { inchiKey: identifiers.inchiKey } : {}),
    ...(identifiers.smiles !== undefined ? { smiles: identifiers.smiles } : {}),
    ...(identifiers.molecularFormula !== undefined
      ? { molecularFormula: identifiers.molecularFormula }
      : {}),
    ...(identifiers.molecularWeight !== undefined
      ? { molecularWeight: identifiers.molecularWeight }
      : {}),
    ...(identifiers.casNumber !== undefined ? { casNumber: identifiers.casNumber } : {}),
  }
}

function observationTargetToRecord(target: ObservationTargetRef): ObservationTargetRef {
  return {
    ...(target.name !== undefined ? { name: target.name } : {}),
    ...(target.sourceTargetId !== undefined ? { sourceTargetId: target.sourceTargetId } : {}),
    ...(target.sourceTargetUrl !== undefined ? { sourceTargetUrl: target.sourceTargetUrl } : {}),
    ...(target.organism !== undefined ? { organism: target.organism } : {}),
  }
}

function observationAssayToRecord(assay: ObservationAssay): ObservationAssay {
  return {
    ...(assay.assayId !== undefined ? { assayId: assay.assayId } : {}),
    ...(assay.assayType !== undefined ? { assayType: assay.assayType } : {}),
    ...(assay.description !== undefined ? { description: assay.description } : {}),
  }
}

function observationReferenceToRecord(reference: ObservationReference): ObservationReference {
  return {
    ...(reference.referenceId !== undefined ? { referenceId: reference.referenceId } : {}),
    ...(reference.journal !== undefined ? { journal: reference.journal } : {}),
    ...(reference.year !== undefined ? { year: reference.year } : {}),
  }
}

/**
 * One stored measurement, written field by field. Every field is carried
 * exactly as reported — endpoint spelling, value, unit, qualifier, raw
 * relation and all context — and an absent field stays absent. Nothing is
 * mapped onto a model parameter here: `parameterKind` is only ever the
 * source's own canonical endpoint classification.
 */
function observationToRecord(observation: ImportedObservation): ImportedObservation {
  return {
    id: observation.id,
    compoundId: observation.compoundId,
    compoundSourceId: observation.compoundSourceId,
    ...(observation.compoundName !== undefined ? { compoundName: observation.compoundName } : {}),
    target: observationTargetToRecord(observation.target),
    endpoint: observation.endpoint,
    ...(observation.parameterKind !== undefined
      ? { parameterKind: observation.parameterKind }
      : {}),
    value: observation.value,
    ...(observation.unit !== undefined ? { unit: observation.unit } : {}),
    ...(observation.qualifier !== undefined ? { qualifier: observation.qualifier } : {}),
    ...(observation.rawRelation !== undefined ? { rawRelation: observation.rawRelation } : {}),
    ...(observation.species !== undefined ? { species: observation.species } : {}),
    ...(observation.assay !== undefined
      ? { assay: observationAssayToRecord(observation.assay) }
      : {}),
    ...(observation.reference !== undefined
      ? { reference: observationReferenceToRecord(observation.reference) }
      : {}),
    ...(observation.activityComment !== undefined
      ? { activityComment: observation.activityComment }
      : {}),
    ...(observation.dataValidityNote !== undefined
      ? { dataValidityNote: observation.dataValidityNote }
      : {}),
    provenance: sourceAttributionToRecord(observation.provenance),
    createdAt: observation.createdAt,
    updatedAt: observation.updatedAt,
  }
}

/** One imported source record, written field by field (absent stays absent). */
function sourceRecordToRecord(record: DrugSourceRecord): DrugSourceRecord {
  return {
    source: record.source,
    sourceId: record.sourceId,
    ...(record.name !== undefined ? { name: record.name } : {}),
    synonyms: [...record.synonyms],
    identifiers: compoundIdentifiersToRecord(record.identifiers),
    provenance: sourceAttributionToRecord(record.provenance),
    observations: record.observations.map(observationToRecord),
    importedAt: record.importedAt,
  }
}

/**
 * Domain -> storage. Absent optional fields are omitted (never written as
 * `undefined`), so "field cleared" is stored as "field absent" and unknown
 * fields are decided solely by `preserveUnknownFields`.
 */
export function toRecord(drug: Drug, persistenceVersion = PERSISTENCE_VERSION): DrugRecord {
  const record: DrugRecord = {
    id: drug.id,
    origin: drug.origin,
    identifiers: {
      name: drug.identifiers.name,
      synonyms: [...drug.identifiers.synonyms],
      ...(drug.identifiers.description !== undefined
        ? { description: drug.identifiers.description }
        : {}),
      ...(drug.identifiers.casNumber !== undefined ? { casNumber: drug.identifiers.casNumber } : {}),
    },
    tags: [...drug.tags],
    targets: drug.targets.map(targetToRecord),
    pharmacokinetics: {
      ...(drug.pharmacokinetics.halfLife !== undefined
        ? { halfLife: parameterToRecord(drug.pharmacokinetics.halfLife) }
        : {}),
      ...(drug.pharmacokinetics.clearance !== undefined
        ? { clearance: parameterToRecord(drug.pharmacokinetics.clearance) }
        : {}),
      ...(drug.pharmacokinetics.volumeOfDistribution !== undefined
        ? { volumeOfDistribution: parameterToRecord(drug.pharmacokinetics.volumeOfDistribution) }
        : {}),
      ...(drug.pharmacokinetics.bioavailability !== undefined
        ? { bioavailability: parameterToRecord(drug.pharmacokinetics.bioavailability) }
        : {}),
      ...(drug.pharmacokinetics.notes !== undefined
        ? { notes: drug.pharmacokinetics.notes }
        : {}),
    },
    ...(drug.notes !== undefined ? { notes: drug.notes } : {}),
    // Phase 36: imported source data is a known field the mapper owns. An
    // empty list stays absent (never written as `[]`), and a record that
    // never imported anything simply omits the key.
    ...(drug.sourceRecords !== undefined && drug.sourceRecords.length > 0
      ? { sourceRecords: drug.sourceRecords.map(sourceRecordToRecord) }
      : {}),
    ...(drug.createdAt !== undefined ? { createdAt: drug.createdAt } : {}),
    ...(drug.updatedAt !== undefined ? { updatedAt: drug.updatedAt } : {}),
    persistenceVersion,
  }
  return record
}

export type DrugRecordValidation =
  | { readonly ok: true; readonly drug: Drug }
  | { readonly ok: false; readonly errors: readonly string[] }

/**
 * Storage -> domain. Validates with the shared NPSL drug schema; unknown
 * keys survive the loose parse (they ride along in the returned object and
 * are re-attached on write by `preserveUnknownFields` even if a mapper
 * drops them). Never repairs or mutates the raw record.
 */
export function fromRecord(raw: unknown): DrugRecordValidation {
  const parsed = drugSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
      ),
    }
  }
  // The NPSL schema is structurally the domain Drug (both describe the same
  // scientific shape); zod's optional-undefined typing differs from the
  // domain's exact-optional typing, so this is a type-level bridge only.
  // Persistence bookkeeping (`persistenceVersion`, and the phase-20
  // `revision` token) belongs to the record layer alone and is stripped
  // from the domain view — the authoritative revision a domain drug
  // carries is attached by the repository from the `revisions` table,
  // never read from a row; unknown future fields ride along harmlessly —
  // writes re-attach them from the raw record (toStoredRecord), never
  // from the domain object.
  const data = parsed.data as Drug & { readonly persistenceVersion?: unknown }
  const { persistenceVersion: _bookkeeping, revision: _revision, ...domain } = data
  return { ok: true, drug: domain }
}

/**
 * Full rewrite of a record from its new domain value: contract fields come
 * from the domain, unknown fields from their sources, bookkeeping version
 * from the record (or the current build for new records).
 *
 * Extension sources, in priority order:
 * 1. the incoming `drug` — a freshly imported record carries its file's
 *    extensions (the loose schema lets them ride into the domain value), so
 *    replace imports and first-time merge imports keep them;
 * 2. the previous stored record — edits and merge updates keep storage
 *    extensions the incoming value never mentioned.
 *
 * A source only fills keys the rewritten record does not already have, so
 * when an incoming file and the stored record both define an unknown key,
 * the file's value wins (documented Merge collision policy), and known
 * domain fields are never touched by extension preservation.
 */
export function toStoredRecord(existing: DrugRecord | undefined, drug: Drug): DrugRecord {
  const next = toRecord(drug, existing?.persistenceVersion ?? PERSISTENCE_VERSION)
  preserveUnknownFields(drug, next, 'root')
  if (existing !== undefined) {
    preserveUnknownFields(existing, next, 'root')
  }
  return next
}

/** Library metadata is a plain storage document — stored as the domain shape. */
export type LibraryMetadataRecord = LibraryMetadata
