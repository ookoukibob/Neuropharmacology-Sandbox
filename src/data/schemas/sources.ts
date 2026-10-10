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
 * Pure schema module: no React, no I/O.
 */
import { z } from 'zod'
import type { Compound } from '../../domain/sources/compound'
import type { ExperimentalObservation } from '../../domain/sources/observation'

const isoDateTime = z.iso.datetime({
  offset: true,
  message: 'must be an ISO 8601 date-time (e.g. 2026-10-08T12:00:00Z)',
})

export const sourceAttributionSchema = z.looseObject({
  source: z.string().min(1),
  sourceName: z.string().min(1),
  recordId: z.string().min(1),
  url: z.string().min(1),
  retrievedAt: isoDateTime,
  sourceVersion: z.string().min(1).optional(),
  licenseNotice: z.string().min(1).optional(),
  licenseUrl: z.string().url().optional(),
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

export function parseCompoundRecord(raw: unknown): SourceRecordValidation<Compound> {
  const parsed = compoundRecordSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: issuesOf(parsed.error) }
  return { ok: true, record: parsed.data as Compound }
}

export function parseObservationRecord(raw: unknown): SourceRecordValidation<ExperimentalObservation> {
  const parsed = observationRecordSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, errors: issuesOf(parsed.error) }
  return { ok: true, record: parsed.data as ExperimentalObservation }
}
