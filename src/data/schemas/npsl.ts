import { z } from 'zod'

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
 *   `ic50`, PK values), their `provenance` objects, and
 *   `pharmacokinetics`.
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
