/**
 * Runtime schemas for experimental datasets (phase 47A).
 *
 * Two boundaries share one shape definition:
 * - `experimentalDatasetInputSchema` validates imported CSV rows and `.npex`
 *   content before any local identity is assigned;
 * - `experimentalDatasetRecordSchema` validates the stored record on every
 *   read and write (id + timestamps + per-measurement local ids).
 *
 * The `.npex` interchange boundary uses the STRICT variants (unknown keys
 * rejected, explicit version); stored and CSV-facing schemas are permissive
 * about unknown keys, matching the repository's forward-compatible read
 * policy. That permissiveness stops at the reserved censoring fields: every
 * boundary runs `validateMeasurementContract`, so an observation can never be
 * partly quantified and partly censored (see `measurementContractIssues`).
 *
 * `sourceRow` is validated as a source row number only. It never doubles as a
 * database key.
 *
 * Pure schema module: no React, no I/O, no storage.
 */
import { z } from 'zod'
import {
  MAX_CENSORED_RAW_TEXT_LENGTH,
  MAX_DATASET_MEASUREMENTS,
  MAX_DATASET_NAME_LENGTH,
  MAX_DATASET_NOTES_LENGTH,
  MAX_MEASUREMENT_NOTE_LENGTH,
  MAX_SAMPLE_ID_LENGTH,
  concentrationUnitIssue,
  measurementContractIssues,
  timeUnitIssue,
  validateAdministration,
  type AdministrationMetadata,
} from '../../domain/experiments/experimental-dataset'

const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)) && /T\d{2}:\d{2}:\d{2}/.test(value), {
    message: 'must be an ISO 8601 date-time string',
  })

const nonNegativeFinite = z
  .number()
  .finite('must be a finite number')
  .min(0, 'must be zero or greater')

const sourceRowSchema = z
  .number()
  .int('must be a whole-number data row')
  .positive('must be a 1-based data row')
  .max(Number.MAX_SAFE_INTEGER, 'is outside the supported row range')

const optionalText = (max: number, label: string) =>
  z.string().min(1, `${label} must not be empty`).max(max, `${label} is too long`).optional()

const provenanceFields = {
  source: z.enum(['csv', 'npex']),
  fileName: z.string().min(1).max(255).optional(),
  importedAt: isoDateTime,
}

const measurementCommonFields = {
  sourceRow: sourceRowSchema,
  time: nonNegativeFinite,
  sampleId: optionalText(MAX_SAMPLE_ID_LENGTH, 'sample id'),
  note: optionalText(MAX_MEASUREMENT_NOTE_LENGTH, 'measurement note'),
}

/** A quantification limit must be a finite, strictly positive concentration. */
const positiveFinite = z
  .number()
  .finite('must be a finite number')
  .positive('must be greater than zero')

/** A quantified observation: an actual measured, finite, non-negative concentration. */
const quantifiedMeasurementFields = {
  ...measurementCommonFields,
  concentration: nonNegativeFinite,
}

/** A below-quantification-limit observation: a limit, never a concentration. */
const censoredMeasurementFields = {
  ...measurementCommonFields,
  censored: z.literal(true),
  censoring: z.literal('below-quantification-limit'),
  rawText: z
    .string()
    .min(1, 'the original below-limit text is required')
    .max(MAX_CENSORED_RAW_TEXT_LENGTH, 'the original below-limit text is too long'),
  limit: positiveFinite,
}

const baseFields = {
  name: z.string().min(1, 'a dataset name is required').max(MAX_DATASET_NAME_LENGTH),
  timeUnit: z.string().min(1, 'a time unit is required'),
  concentrationUnit: z.string().min(1, 'a concentration unit is required'),
  notes: z.string().max(MAX_DATASET_NOTES_LENGTH).optional(),
}

const provenanceSchema = z.looseObject(provenanceFields)

// ---------------------------------------------------------------------------
// Administration metadata (phase 50A)
// ---------------------------------------------------------------------------

const administrationQuantityFields = {
  value: z.number().finite('must be a finite number'),
  unit: z.string().min(1, 'a unit is required'),
}

const administrationFields = {
  route: z.enum(['iv-bolus', 'iv-infusion', 'extravascular', 'other', 'unknown']),
  dose: z.looseObject(administrationQuantityFields).optional(),
  doseBasis: z.enum(['per-administration', 'total-regimen', 'unknown']).optional(),
  infusion: z
    .looseObject({
      duration: z.looseObject(administrationQuantityFields).optional(),
      rate: z.looseObject(administrationQuantityFields).optional(),
    })
    .optional(),
  regimen: z.enum(['single-dose', 'repeated-dose', 'repeated-dose-steady-state', 'unknown']),
  dosingInterval: z.looseObject(administrationQuantityFields).optional(),
  timeReference: z.enum(['dose-time', 'infusion-start', 'first-observation', 'other', 'unknown']),
  bioavailability: z.number().finite('must be a finite number').optional(),
}

/** Loose (stored/CSV-facing) administration metadata: forward-compatible. */
const administrationMetadataSchema = z.looseObject(administrationFields)

/** Strict (`.npex`) administration metadata: unknown keys are rejected. */
const administrationMetadataNpexSchema = z.strictObject({
  route: z.enum(['iv-bolus', 'iv-infusion', 'extravascular', 'other', 'unknown']),
  dose: z.strictObject(administrationQuantityFields).optional(),
  doseBasis: z.enum(['per-administration', 'total-regimen', 'unknown']).optional(),
  infusion: z
    .strictObject({
      duration: z.strictObject(administrationQuantityFields).optional(),
      rate: z.strictObject(administrationQuantityFields).optional(),
    })
    .optional(),
  regimen: z.enum(['single-dose', 'repeated-dose', 'repeated-dose-steady-state', 'unknown']),
  dosingInterval: z.strictObject(administrationQuantityFields).optional(),
  timeReference: z.enum(['dose-time', 'infusion-start', 'first-observation', 'other', 'unknown']),
  bioavailability: z.number().finite('must be a finite number').optional(),
})

/** Semantic administration rules (unit dimensions, infusion XOR, F range). */
function validateAdministrationField(value: unknown, ctx: z.RefinementCtx): void {
  if (value === undefined || value === null) return
  // The structural schema already narrowed the shape; the domain validator owns
  // the scientific rules. The cast bridges zod's `| undefined` optionals and
  // the domain's exact-optional typing (the same gap `toDataset` bridges).
  for (const issue of validateAdministration(value as AdministrationMetadata)) {
    ctx.addIssue({
      code: 'custom',
      path: ['administration', ...issue.field.split('.')],
      message: issue.message,
    })
  }
}

/**
 * The measurement contract (phase 50F hardening), shared by every boundary:
 * the loose objects below stay forward-compatible about unknown keys, but the
 * reserved censoring fields may not be mixed between the two observation
 * shapes, and an inline `<number` bound must agree with the recorded `limit`.
 */
function validateMeasurementContract(value: unknown, ctx: z.RefinementCtx): void {
  for (const issue of measurementContractIssues(value)) {
    ctx.addIssue({ code: 'custom', path: [issue.field], message: issue.message })
  }
}

/** Measurement as supplied by an import (no local identity yet). */
export const experimentalMeasurementInputSchema = z
  .union([
    z.looseObject(quantifiedMeasurementFields),
    z.looseObject(censoredMeasurementFields),
  ])
  .superRefine(validateMeasurementContract)

/** Stored measurement: local identity is an address, never a source row. */
export const experimentalMeasurementRecordSchema = z
  .union([
    z.looseObject({ ...quantifiedMeasurementFields, id: z.string().min(1).max(200) }),
    z.looseObject({ ...censoredMeasurementFields, id: z.string().min(1).max(200) }),
  ])
  .superRefine(validateMeasurementContract)

const measurementsInputSchema = z
  .array(experimentalMeasurementInputSchema)
  .min(1, 'at least one measurement is required')
  .max(
    MAX_DATASET_MEASUREMENTS,
    `a dataset may contain at most ${MAX_DATASET_MEASUREMENTS} measurements`,
  )

const measurementsRecordSchema = z
  .array(experimentalMeasurementRecordSchema)
  .min(1, 'at least one measurement is required')
  .max(
    MAX_DATASET_MEASUREMENTS,
    `a dataset may contain at most ${MAX_DATASET_MEASUREMENTS} measurements`,
  )

type UnitFields = { readonly timeUnit: string; readonly concentrationUnit: string }

function validateUnits(value: UnitFields, ctx: z.RefinementCtx): void {
  const timeIssue = timeUnitIssue(value.timeUnit)
  if (timeIssue !== null) {
    ctx.addIssue({ code: 'custom', path: ['timeUnit'], message: timeIssue })
  }
  const concentrationIssue = concentrationUnitIssue(value.concentrationUnit)
  if (concentrationIssue !== null) {
    ctx.addIssue({ code: 'custom', path: ['concentrationUnit'], message: concentrationIssue })
  }
}

/** Imported content before local ids/timestamps are assigned (CSV/storage read). */
export const experimentalDatasetInputSchema = z
  .looseObject({
    ...baseFields,
    provenance: provenanceSchema,
    measurements: measurementsInputSchema,
    administration: administrationMetadataSchema.optional(),
  })
  .superRefine((value, ctx) => {
    validateUnits(value, ctx)
    validateAdministrationField(value.administration, ctx)
  })

/**
 * `.npex` dataset shape: unknown keys are rejected, so a typo or an unsupported
 * extension can never be silently ignored. The envelope version is checked
 * separately, before this schema runs.
 */
export const experimentalDatasetNpexSchema = z
  .strictObject({
    ...baseFields,
    provenance: z.strictObject(provenanceFields),
    measurements: z
      .array(
        z
          .union([
            z.strictObject(quantifiedMeasurementFields),
            z.strictObject(censoredMeasurementFields),
          ])
          .superRefine(validateMeasurementContract),
      )
      .min(1, 'at least one measurement is required')
      .max(
        MAX_DATASET_MEASUREMENTS,
        `a dataset may contain at most ${MAX_DATASET_MEASUREMENTS} measurements`,
      ),
    administration: administrationMetadataNpexSchema.optional(),
  })
  .superRefine((value, ctx) => {
    validateUnits(value, ctx)
    validateAdministrationField(value.administration, ctx)
  })

/** The persisted record shape (keyed by `id` in `experimentDatasets`). */
export const experimentalDatasetRecordSchema = z
  .looseObject({
    ...baseFields,
    id: z.string().min(1).max(200),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    provenance: provenanceSchema,
    measurements: measurementsRecordSchema,
    administration: administrationMetadataSchema.optional(),
  })
  .superRefine((value, ctx) => {
    validateUnits(value, ctx)
    validateAdministrationField(value.administration, ctx)
    const seen = new Set<string>()
    value.measurements.forEach((measurement, index) => {
      if (seen.has(measurement.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['measurements', index, 'id'],
          message: `duplicate measurement id "${measurement.id}"`,
        })
      }
      seen.add(measurement.id)
    })
  })

export type ExperimentalDatasetRecord = z.infer<typeof experimentalDatasetRecordSchema>
export type ExperimentalMeasurementRecord = z.infer<typeof experimentalMeasurementRecordSchema>
