/**
 * Runtime validation for the Layer A / Layer B record shapes stored in the
 * source-data tables (`compounds`, `observations`).
 *
 * These schemas are the repository-boundary contract: every record a
 * source adapter hands in is validated here inside the import transaction
 * (a preview never substitutes for this check), and every record read back
 * from storage is validated before it reaches the UI. Objects are parsed
 * "loose" (unknown keys are kept), so fields from future schema minor
 * versions round-trip verbatim — the same forward-compatibility rule the
 * NPSL drug schema follows (see schemas/npsl.ts).
 *
 * Beyond shape, the boundary also enforces the cross-field identity
 * invariants derived from the deterministic id factories (see
 * `compoundIdentityIssues` / `observationIdentityIssues` below): a
 * structurally valid but internally contradictory record is malformed.
 *
 * Pure schema module: no React, no I/O.
 */
import { z } from 'zod'
import { compoundId, type Compound } from '../../domain/sources/compound'
import { observationId, type ExperimentalObservation } from '../../domain/sources/observation'

const isoDateTime = z.iso.datetime({
  offset: true,
  message: 'must be an ISO 8601 date-time (e.g. 2026-10-08T12:00:00Z)',
})

/**
 * External attribution links must be absolute HTTPS URLs — validated
 * with the platform URL parser (not a string regex): malformed strings,
 * relative paths, whitespace-only values and non-HTTPS schemes
 * (`javascript:`, `file:`, ...) are rejected with a message that names
 * the offending field. Validation never fetches or navigates.
 */
export const httpsUrl = z
  .string()
  .min(1, 'must be an absolute HTTPS URL')
  .refine(
    (value) => {
      try {
        return new URL(value).protocol === 'https:'
      } catch {
        return false
      }
    },
    'must be an absolute HTTPS URL',
  )

export const sourceAttributionSchema = z.looseObject({
  source: z.string().min(1),
  sourceName: z.string().min(1),
  recordId: z.string().min(1),
  url: httpsUrl,
  retrievedAt: isoDateTime,
  sourceVersion: z.string().min(1).optional(),
  licenseNotice: z.string().min(1).optional(),
  licenseUrl: httpsUrl.optional(),
})

export const compoundRecordSchema = z.looseObject({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceId: z.string().min(1),
  name: z.string().min(1).optional(),
  synonyms: z.array(z.string()),
  identifiers: z.looseObject({
    pubchemCid: z.string().min(1).optional(),
    chemblId: z.string().min(1).optional(),
    inchiKey: z.string().min(1).optional(),
    smiles: z.string().min(1).optional(),
    molecularFormula: z.string().min(1).optional(),
    molecularWeight: z.number().finite().optional(),
    casNumber: z.string().min(1).optional(),
  }),
  provenance: sourceAttributionSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})

export const qualifierSchema = z.enum(['<', '>', '<=', '>=', '=', '~'])
export const parameterKindSchema = z.enum(['kd', 'ki', 'ec50', 'ic50'])

export const observationRecordSchema = z.looseObject({
  id: z.string().min(1),
  compoundId: z.string().min(1),
  compoundSourceId: z.string().min(1),
  compoundName: z.string().min(1).optional(),
  target: z.looseObject({
    name: z.string().min(1).optional(),
    sourceTargetId: z.string().min(1).optional(),
    sourceTargetUrl: httpsUrl.optional(),
    organism: z.string().min(1).optional(),
  }),
  endpoint: z.string().min(1),
  parameterKind: parameterKindSchema.optional(),
  value: z.number().finite(),
  unit: z.string().min(1).optional(),
  qualifier: qualifierSchema.optional(),
  rawRelation: z.string().min(1).optional(),
  species: z.string().min(1).optional(),
  assay: z
    .looseObject({
      assayId: z.string().min(1).optional(),
      assayType: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
    })
    .optional(),
  reference: z
    .looseObject({
      referenceId: z.string().min(1).optional(),
      journal: z.string().min(1).optional(),
      year: z.number().int().optional(),
    })
    .optional(),
  activityComment: z.string().min(1).optional(),
  dataValidityNote: z.string().min(1).optional(),
  provenance: sourceAttributionSchema,
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
})

/**
 * Validation result in the established `fromRecord` style: ok with the
 * domain object, or the list of schema issues — never a silent drop and
 * never a repair. The zod output is structurally the domain shape (both
 * describe the same record); zod's optional-undefined typing differs from
 * the domain's exact-optional typing, so this is a type-level bridge only.
 */
export type SourceRecordValidation<T> =
  | { readonly ok: true; readonly record: T }
  | { readonly ok: false; readonly errors: readonly string[] }

function issuesOf(error: z.ZodError): readonly string[] {
  return error.issues.map(
    (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '(root)'}: ${issue.message}`,
  )
}

/**
 * Cross-field identity invariants, derived from the deterministic id
 * factories (`compoundId` / `observationId`) and the adapter contracts —
 * not new identity semantics. A record can be structurally valid and still
 * be internally contradictory (an id that names a different source record,
 * provenance pointing at another record, an encoded compound reference
 * that does not match its parts); such a record is malformed and is
 * rejected at the same boundary as a schema failure — never repaired,
 * never written. Messages name the offending fields so the conflict is
 * actionable.
 */
function compoundIdentityIssues(record: Compound): readonly string[] {
  const issues: string[] = []
  const expectedId = compoundId(record.source, record.sourceId)
  if (record.id !== expectedId) {
    issues.push(
      `id "${record.id}" does not match source "${record.source}" + sourceId "${record.sourceId}" (the deterministic id is "${expectedId}")`,
    )
  }
  if (record.provenance.source !== record.source) {
    issues.push(
      `provenance.source "${record.provenance.source}" does not match record source "${record.source}"`,
    )
  }
  if (record.provenance.recordId !== record.sourceId) {
    issues.push(
      `provenance.recordId "${record.provenance.recordId}" does not match sourceId "${record.sourceId}"`,
    )
  }
  return issues
}

function observationIdentityIssues(record: ExperimentalObservation): readonly string[] {
  const issues: string[] = []
  const expectedId = observationId(record.provenance.source, record.provenance.recordId)
  if (record.id !== expectedId) {
    issues.push(
      `id "${record.id}" does not match provenance.source "${record.provenance.source}" + provenance.recordId "${record.provenance.recordId}" (the deterministic id is "${expectedId}")`,
    )
  }
  // `compoundId` encodes (source, compoundSourceId) exactly as the ChEMBL
  // adapter builds it (`compoundId(provenance.source, compoundSourceId)`).
  const expectedCompoundId = `${record.provenance.source}:${record.compoundSourceId}`
  if (record.compoundId !== expectedCompoundId) {
    issues.push(
      `compoundId "${record.compoundId}" does not match provenance.source "${record.provenance.source}" + compoundSourceId "${record.compoundSourceId}" (expected "${expectedCompoundId}")`,
    )
  }
  return issues
}

export function parseCompoundRecord(raw: unknown): SourceRecordValidation<Compound> {
  const parsed = compoundRecordSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: issuesOf(parsed.error) }
  const record = parsed.data as Compound
  const issues = compoundIdentityIssues(record)
  if (issues.length > 0) return { ok: false, errors: issues }
  return { ok: true, record }
}

export function parseObservationRecord(raw: unknown): SourceRecordValidation<ExperimentalObservation> {
  const parsed = observationRecordSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: issuesOf(parsed.error) }
  const record = parsed.data as ExperimentalObservation
  const issues = observationIdentityIssues(record)
  if (issues.length > 0) return { ok: false, errors: issues }
  return { ok: true, record }
}
