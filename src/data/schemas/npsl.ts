import { z } from 'zod'
import {
  httpsUrl,
  parameterKindSchema,
  qualifierSchema,
  sourceAttributionSchema,
} from './sources'

/**
 * NPSL — Neuropharmacology Sandbox Library format.
 *
 * Versioning contract:
 * - `formatVersion`  — version of the file envelope (top-level structure).
 * - `schemaVersion`  — version of the data schema (drug records, parameters).
 *
 * Readers support files whose major version matches the constants below and
 * whose minor version is <= the constants below; anything else is rejected
 * with an explicit message instead of being partially imported.
 *
 * Forward compatibility: objects are parsed "loose" (unknown keys are kept,
 * not rejected). What survives a full `parse → validate → import → storage
 * → export` round trip (phase-5 hardening, tested through the repository):
 * - unknown keys inside `libraryMetadata`;
 * - unknown keys at every nesting level of `drugs`: the record root,
 *   `identifiers`, `targets[]`, the scientific parameters (`kd`/`ki`/`ec50`/
 *   `ic50`, PK values), their `provenance` objects,
 *   `pharmacokinetics`, and (phase 36) `sourceRecords[]` with each
 *   snapshot's `identifiers`, `provenance` and `observations[]`.
 * Merge policy for an existing id: an incoming extension is written (the
 * file wins a key collision); stored extensions the file never mentions
 * are kept (see `toStoredRecord`).
 * NOT retained: unknown keys at the top level of the envelope itself —
 * storage has no place for them, so the import reports warning
 * `ENVELOPE_FIELDS_DROPPED` rather than dropping them silently.
 * Known fields are still strictly typed: a wrong type is a hard error.
 *
 * Scientific parameters are NEVER flattened: every parameter is
 * `{ value, unit, provenance }` and every provenance is a discriminated
 * object with `type`.
 */

export const NPSL_FILE_EXTENSION = '.npsl'
export const NPSL_FORMAT_VERSION = '1.0.0'
export const NPSL_SCHEMA_VERSION = '1.0.0'

const semverLike = z
  .string()
  .regex(/^\d+\.\d+\.\d+$/, 'must be a semantic version like "1.0.0"')

const isoDateTime = z.iso.datetime({
  offset: true,
  message: 'must be an ISO 8601 date-time (e.g. 2026-10-08T12:00:00Z)',
})

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const literatureProvenanceSchema = z.looseObject({
  type: z.literal('literature'),
  source: z.string().min(1, 'literature provenance requires a source'),
  citation: z.string().min(1).optional(),
  doi: z.string().min(1).optional(),
  url: z.url().optional(),
  accessedAt: isoDateTime.optional(),
  /** Record id inside `source` — portable attribution for promoted values. */
  sourceRecordId: z.string().min(1).optional(),
  /** Source licensing/attribution notice, verbatim. */
  licenseNotice: z.string().min(1).optional(),
  /** Link to the source's licensing/attribution page. */
  licenseUrl: z.url().optional(),
  /** Explicit Layer B → Layer C link: the stored observation this value came from. */
  observationId: z.string().min(1).optional(),
  notes: z.string().optional(),
})

export const userProvenanceSchema = z.looseObject({
  type: z.literal('user'),
  recordedAt: isoDateTime.optional(),
  notes: z.string().optional(),
})

export const calculatedProvenanceSchema = z.looseObject({
  type: z.literal('calculated'),
  model: z.string().min(1),
  recordedAt: isoDateTime.optional(),
  notes: z.string().optional(),
})

export const derivedProvenanceSchema = z.looseObject({
  type: z.literal('derived'),
  method: z.string().min(1),
  from: z.array(z.string().min(1)).min(1),
  recordedAt: isoDateTime.optional(),
  notes: z.string().optional(),
})

export const unknownProvenanceSchema = z.looseObject({
  type: z.literal('unknown'),
  notes: z.string().optional(),
})

export const provenanceSchema = z.discriminatedUnion('type', [
  literatureProvenanceSchema,
  userProvenanceSchema,
  calculatedProvenanceSchema,
  derivedProvenanceSchema,
  unknownProvenanceSchema,
])

// ---------------------------------------------------------------------------
// Scientific values
// ---------------------------------------------------------------------------

/**
 * The atomic scientific parameter: value + unit + provenance.
 * `value` must be a finite float (no NaN/Infinity).
 */
export const scientificValueSchema = z.looseObject({
  value: z.number().finite(),
  unit: z.string().min(1),
  provenance: provenanceSchema,
})

export type NpslScientificValue = z.infer<typeof scientificValueSchema>

// ---------------------------------------------------------------------------
// Drug record
// ---------------------------------------------------------------------------

export const targetActionSchema = z.enum([
  'agonist',
  'partial-agonist',
  'antagonist',
  'inverse-agonist',
  'modulator',
  'reuptake-inhibitor',
  'unknown',
])

/**
 * One external source's identity for a target (phase 18I): which source
 * system, which authoritative target id in it, the reported name and
 * organism, the target-record URL and the source's licensing terms.
 * URLs follow the established source-attribution rule (absolute HTTPS,
 * validated with the platform URL parser — see schemas/sources.ts).
 * Loose object: unknown keys from future minor versions round-trip.
 */
export const targetSourceReferenceSchema = z.looseObject({
  source: z.string().min(1),
  sourceName: z.string().min(1),
  sourceTargetId: z.string().min(1),
  name: z.string().min(1).optional(),
  organism: z.string().min(1).optional(),
  url: httpsUrl.optional(),
  licenseNotice: z.string().min(1).optional(),
  licenseUrl: httpsUrl.optional(),
})

export const receptorTargetSchema = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  gene: z.string().min(1).optional(),
  action: targetActionSchema.optional(),
  species: z.string().min(1).optional(),
  /** Equilibrium dissociation constant — molar concentration unit expected. */
  kd: scientificValueSchema.optional(),
  /** Inhibition constant — never interchangeable with Kd. */
  ki: scientificValueSchema.optional(),
  ec50: scientificValueSchema.optional(),
  ic50: scientificValueSchema.optional(),
  notes: z.string().optional(),
  /**
   * External source identities (phase 18I). Optional: records without
   * any (all pre-18I data) simply omit the key — never written as an
   * empty array or explicit undefined.
   *
   * Phase 18I.1 enforces the documented invariant "at most one reference
   * per source" here, at the shared authoritative boundary (NPSL import,
   * create/update, hydration): source equality is the EXACT `source`
   * string — the same rule `findSourceReference` /
   * `mergeSourceReferences` and the persistence mapper's by-source
   * matching rely on (adapter ids like 'chembl' are already canonical,
   * so no case-folding or trimming is applied). Two entries with the
   * same `source` are malformed even when their `sourceTargetId` values
   * are identical: they are never merged, deduplicated or resolved
   * first-wins/last-wins — the containing record is rejected, with the
   * issue path pointing at the duplicate entry's `source`.
   */
  sourceReferences: z
    .array(targetSourceReferenceSchema)
    .superRefine((references, ctx) => {
      const firstIndexBySource = new Map<string, number>()
      references.forEach((reference, index) => {
        const previous = firstIndexBySource.get(reference.source)
        if (previous !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'source'],
            input: reference.source,
            message: `duplicate source reference: "${reference.source}" already appears at index ${previous} — a target carries at most one reference per source; duplicates are rejected, never merged or deduplicated`,
          })
        } else {
          firstIndexBySource.set(reference.source, index)
        }
      })
    })
    .optional(),
})

// ---------------------------------------------------------------------------
// Imported source-data snapshot (phase 36)
// ---------------------------------------------------------------------------

/**
 * Compound identifiers and chemical properties as reported by an external
 * source (Layer A). Every field is optional: a source that supplies no
 * CAS number, InChIKey, SMILES or molecular weight leaves the key absent —
 * nothing is ever filled in, derived or guessed. `molecularWeight` is the
 * source's average molecular weight in g/mol (the unit is part of the
 * field's meaning, exactly as in `CompoundIdentifiers`).
 */
export const compoundIdentifiersSchema = z.looseObject({
  pubchemCid: z.string().min(1).optional(),
  chemblId: z.string().min(1).optional(),
  inchiKey: z.string().min(1).optional(),
  smiles: z.string().min(1).optional(),
  molecularFormula: z.string().min(1).optional(),
  molecularWeight: z.number().finite().optional(),
  casNumber: z.string().min(1).optional(),
})

// Attribution, qualifier and parameter-kind shapes are the SAME schemas the
// Layer A/B stores validate against (`schemas/sources.ts`): a snapshot is a
// copy of those records, so its contract must never drift from theirs.

export const observationTargetRefSchema = z.looseObject({
  name: z.string().min(1).optional(),
  sourceTargetId: z.string().min(1).optional(),
  sourceTargetUrl: httpsUrl.optional(),
  organism: z.string().min(1).optional(),
})

export const observationAssaySchema = z.looseObject({
  assayId: z.string().min(1).optional(),
  assayType: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
})

export const observationReferenceSchema = z.looseObject({
  referenceId: z.string().min(1).optional(),
  journal: z.string().min(1).optional(),
  year: z.number().int().optional(),
})

/**
 * One imported measurement, stored exactly as the source reported it.
 *
 * This is a *copy of a source record*, not a model parameter: `endpoint`
 * keeps the source's own spelling ("Ki", "IC50", "Log K'"), `parameterKind`
 * is present only when the endpoint is canonically one of the four named
 * slots, and `value`/`unit`/`qualifier` are the reported numbers and
 * context. Two records may disagree — they are kept side by side and are
 * never averaged, merged or silently dropped.
 */
export const importedObservationSchema = z.looseObject({
  id: z.string().min(1),
  compoundId: z.string().min(1),
  compoundSourceId: z.string().min(1),
  compoundName: z.string().min(1).optional(),
  target: observationTargetRefSchema,
  endpoint: z.string().min(1),
  parameterKind: parameterKindSchema.optional(),
  value: z.number().finite(),
  unit: z.string().min(1).optional(),
  qualifier: qualifierSchema.optional(),
  rawRelation: z.string().min(1).optional(),
  species: z.string().min(1).optional(),
  assay: observationAssaySchema.optional(),
  reference: observationReferenceSchema.optional(),
  activityComment: z.string().min(1).optional(),
  dataValidityNote: z.string().min(1).optional(),
  provenance: sourceAttributionSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})

/**
 * One imported external compound record attached to a drug (phase 36):
 * its external identity (`source` + `sourceId`), the preferred name and
 * every synonym, its structured identifiers/properties, the full source
 * attribution with license terms, and the measurements stored for exactly
 * that record.
 *
 * Cross-field invariants enforced here — at the ONE boundary every write
 * path (import, create, edit, hydration, `.npsl`) passes through — are the
 * same ones the source-data repository enforces on Layer A/B:
 *
 * - at most one snapshot per exact `source` string (a second record from
 *   the same source system is a conflict, never merged or overwritten);
 * - an observation may only be attached to the snapshot of the compound it
 *   was reported for: its `compoundId` must equal
 *   `${source}:${sourceId}` (a display-name match alone never links a
 *   measurement);
 * - an observation's own identity must match its provenance
 *   (`${provenance.source}:${provenance.recordId}`), the same
 *   deterministic rule the Layer B store enforces;
 * - observation ids are unique within one snapshot, so a repeated import
 *   can never duplicate a measurement.
 */
export const drugSourceRecordSchema = z
  .looseObject({
    source: z.string().min(1),
    sourceId: z.string().min(1),
    name: z.string().min(1).optional(),
    synonyms: z.array(z.string()),
    identifiers: compoundIdentifiersSchema,
    provenance: sourceAttributionSchema,
    observations: z.array(importedObservationSchema),
    importedAt: isoDateTime,
  })
  .superRefine((record, ctx) => {
    if (record.provenance.source !== record.source) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'source'],
        input: record.provenance.source,
        message: `provenance.source "${record.provenance.source}" does not match the snapshot's source "${record.source}"`,
      })
    }
    if (record.provenance.recordId !== record.sourceId) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'recordId'],
        input: record.provenance.recordId,
        message: `provenance.recordId "${record.provenance.recordId}" does not match the snapshot's sourceId "${record.sourceId}"`,
      })
    }
    const expectedCompoundId = `${record.source}:${record.sourceId}`
    const seen = new Map<string, number>()
    record.observations.forEach((observation, index) => {
      if (observation.compoundId !== expectedCompoundId) {
        ctx.addIssue({
          code: 'custom',
          path: ['observations', index, 'compoundId'],
          input: observation.compoundId,
          message: `observation "${observation.id}" belongs to compound "${observation.compoundId}", not to this snapshot's compound "${expectedCompoundId}" — a measurement is linked by validated source identity, never by name`,
        })
      }
      const expectedObservationId = `${observation.provenance.source}:${observation.provenance.recordId}`
      if (observation.id !== expectedObservationId) {
        ctx.addIssue({
          code: 'custom',
          path: ['observations', index, 'id'],
          input: observation.id,
          message: `observation id "${observation.id}" does not match its provenance "${expectedObservationId}"`,
        })
      }
      const previous = seen.get(observation.id)
      if (previous !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['observations', index, 'id'],
          input: observation.id,
          message: `duplicate observation "${observation.id}" already appears at index ${previous} — repeated imports never duplicate a measurement`,
        })
      } else {
        seen.set(observation.id, index)
      }
    })
  })

export const pharmacokineticsSchema = z.looseObject({
  /** time unit expected (s, min, h, d). */
  halfLife: scientificValueSchema.optional(),
  /** volume/time unit expected (e.g. "mL/min"). */
  clearance: scientificValueSchema.optional(),
  /** volume unit expected (e.g. "L"). */
  volumeOfDistribution: scientificValueSchema.optional(),
  /** dimensionless fraction or percent. */
  bioavailability: scientificValueSchema.optional(),
  notes: z.string().optional(),
})

export const drugSchema = z.looseObject({
  id: z.string().min(1),
  origin: z.enum(['built-in-demo', 'user', 'imported']),
  identifiers: z.looseObject({
    name: z.string().min(1),
    synonyms: z.array(z.string()).default([]),
    description: z.string().optional(),
    casNumber: z.string().min(1).optional(),
  }),
  tags: z.array(z.string()).default([]),
  targets: z.array(receptorTargetSchema).default([]),
  pharmacokinetics: pharmacokineticsSchema.default({}),
  notes: z.string().optional(),
  /**
   * Imported source-data snapshots (phase 36). Optional and additive:
   * records and files without imported source data simply omit the key, so
   * every legacy record and older `.npsl` file keeps loading unchanged
   * (no version bump is needed for an optional key — see ADR-22).
   *
   * At most one snapshot per exact `source` string, mirroring
   * `sourceReferences` (ADR-20): a second entry with the same source is
   * malformed even when its `sourceId` is identical — it is rejected with
   * the duplicate entry's path named, never merged or deduplicated.
   */
  sourceRecords: z
    .array(drugSourceRecordSchema)
    .superRefine((records, ctx) => {
      const firstIndexBySource = new Map<string, number>()
      records.forEach((record, index) => {
        const previous = firstIndexBySource.get(record.source)
        if (previous !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: [index, 'source'],
            input: record.source,
            message: `duplicate source record: "${record.source}" already appears at index ${previous} — a drug carries at most one imported snapshot per source; duplicates are rejected, never merged or deduplicated`,
          })
        } else {
          firstIndexBySource.set(record.source, index)
        }
      })
    })
    .optional(),
  createdAt: isoDateTime.optional(),
  updatedAt: isoDateTime.optional(),
})

// ---------------------------------------------------------------------------
// Library envelope
// ---------------------------------------------------------------------------

export const libraryDataStatusSchema = z.enum([
  'example',
  'sourced',
  'mixed',
  'user',
  'unspecified',
])

export const libraryMetadataSchema = z.looseObject({
  /** Optional: importers generate an id when absent. */
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  author: z.string().min(1).optional(),
  description: z.string().optional(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  dataStatus: libraryDataStatusSchema.default('unspecified'),
})

export const npslFileSchema = z.looseObject({
  formatVersion: semverLike,
  schemaVersion: semverLike,
  libraryMetadata: libraryMetadataSchema,
  drugs: z.array(drugSchema),
})

export type NpslFile = z.infer<typeof npslFileSchema>
export type NpslProvenance = z.infer<typeof provenanceSchema>
export type NpslDrug = z.infer<typeof drugSchema>
export type NpslLibraryMetadata = z.infer<typeof libraryMetadataSchema>

// ---------------------------------------------------------------------------
// Version compatibility (pure helpers, unit-testable)
// ---------------------------------------------------------------------------

export type VersionCompatibility =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

function isSupportedVersion(candidate: string, reader: string): VersionCompatibility {
  const [cMajor = Number.NaN, cMinor = Number.NaN] = candidate
    .split('.')
    .map(Number)
  const [rMajor = Number.NaN, rMinor = Number.NaN] = reader
    .split('.')
    .map(Number)
  if ([cMajor, cMinor, rMajor, rMinor].some((part) => !Number.isInteger(part))) {
    return { ok: false, reason: `version "${candidate}" is not a valid semantic version` }
  }
  if (cMajor !== rMajor) {
    return {
      ok: false,
      reason: `Major version ${cMajor} is not supported (this build reads major version ${rMajor}).`,
    }
  }
  if (cMinor > rMinor) {
    return {
      ok: false,
      reason: `Minor version ${candidate} is newer than supported ${reader}; update the application to import this file.`,
    }
  }
  return { ok: true }
}

/** Check the file envelope versions against this build's supported versions. */
export function checkNpslVersions(file: {
  readonly formatVersion: string
  readonly schemaVersion: string
}): VersionCompatibility {
  const format = isSupportedVersion(file.formatVersion, NPSL_FORMAT_VERSION)
  if (!format.ok) return { ok: false, reason: `formatVersion: ${format.reason}` }
  const schema = isSupportedVersion(file.schemaVersion, NPSL_SCHEMA_VERSION)
  if (!schema.ok) return { ok: false, reason: `schemaVersion: ${schema.reason}` }
  return { ok: true }
}
