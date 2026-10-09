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
} from '../../domain/drug/drug'
import type { LibraryMetadata } from '../../domain/library/library'
import type {
  MaybeScientificValue,
  ScientificValue,
} from '../../domain/pharmacology/scientific-value'
import { drugSchema } from '../schemas/npsl'

/**
 * Record-shape version written by this build. Aligned with the
 * `SandboxDatabase` schema version (v2) so records and indexes describe the
 * same contract; the 1 -> 2 upgrade backfills it on legacy records.
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
  createdAt?: string
  updatedAt?: string
  persistenceVersion: number
}

/**
 * The DTO key contract — the documented field set of each record level.
 * Anything not listed here is an unknown (future) field and is preserved
 * verbatim across edits; anything listed is owned by the domain value.
 */
const ROOT_KEYS = new Set([
  'id',
  'origin',
  'identifiers',
  'tags',
  'targets',
  'pharmacokinetics',
  'notes',
  'createdAt',
  'updatedAt',
  'persistenceVersion',
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

type Level = 'root' | 'identifiers' | 'target' | 'parameter' | 'provenance' | 'pharmacokinetics'

function keysOf(level: Level): Set<string> {
  switch (level) {
    case 'root':
      return ROOT_KEYS
    case 'identifiers':
      return IDENTIFIER_KEYS
    case 'target':
      return TARGET_KEYS
    case 'parameter':
      return PARAMETER_KEYS
    case 'provenance':
      return PROVENANCE_KEYS
    case 'pharmacokinetics':
      return PK_KEYS
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
    }
  }
}

function parameterToRecord(value: MaybeScientificValue): ScientificValue | undefined {
  if (value === undefined) return undefined
  return { value: value.value, unit: value.unit, provenance: value.provenance }
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
  // Persistence bookkeeping (`persistenceVersion`) belongs to the record
  // layer alone and is stripped from the domain view; unknown future fields
  // ride along harmlessly — writes re-attach them from the raw record
  // (toStoredRecord), never from the domain object.
  const data = parsed.data as Drug & { readonly persistenceVersion?: unknown }
  const { persistenceVersion: _bookkeeping, ...domain } = data
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
