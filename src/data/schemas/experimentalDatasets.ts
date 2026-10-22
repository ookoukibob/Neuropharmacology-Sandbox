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
 * policy.
 *
 * `sourceRow` is validated as a source row number only. It never doubles as a
 * database key.
 *
 * Pure schema module: no React, no I/O, no storage.
 */
import { z } from 'zod'
import {
  MAX_DATASET_MEASUREMENTS,
  MAX_DATASET_NAME_LENGTH,
  MAX_DATASET_NOTES_LENGTH,
  MAX_MEASUREMENT_NOTE_LENGTH,
  MAX_SAMPLE_ID_LENGTH,
  concentrationUnitIssue,
  timeUnitIssue,
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

const measurementFields = {
  sourceRow: sourceRowSchema,
  time: nonNegativeFinite,
  concentration: nonNegativeFinite,
  sampleId: optionalText(MAX_SAMPLE_ID_LENGTH, 'sample id'),
  note: optionalText(MAX_MEASUREMENT_NOTE_LENGTH, 'measurement note'),
}

const baseFields = {
  name: z.string().min(1, 'a dataset name is required').max(MAX_DATASET_NAME_LENGTH),
  timeUnit: z.string().min(1, 'a time unit is required'),
  concentrationUnit: z.string().min(1, 'a concentration unit is required'),
  notes: z.string().max(MAX_DATASET_NOTES_LENGTH).optional(),
}

const provenanceSchema = z.looseObject(provenanceFields)

/** Measurement as supplied by an import (no local identity yet). */
export const experimentalMeasurementInputSchema = z.looseObject(measurementFields)

/** Stored measurement: local identity is an address, never a source row. */
export const experimentalMeasurementRecordSchema = experimentalMeasurementInputSchema.extend({
  id: z.string().min(1).max(200),
})

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
  })
  .superRefine(validateUnits)

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
      .array(z.strictObject(measurementFields))
      .min(1, 'at least one measurement is required')
      .max(
        MAX_DATASET_MEASUREMENTS,
        `a dataset may contain at most ${MAX_DATASET_MEASUREMENTS} measurements`,
      ),
  })
  .superRefine(validateUnits)

/** The persisted record shape (keyed by `id` in `experimentDatasets`). */
export const experimentalDatasetRecordSchema = z
  .looseObject({
    ...baseFields,
    id: z.string().min(1).max(200),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    provenance: provenanceSchema,
    measurements: measurementsRecordSchema,
  })
  .superRefine((value, ctx) => {
    validateUnits(value, ctx)
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
