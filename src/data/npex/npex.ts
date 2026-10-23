/**
 * Versioned `.npex` experimental-dataset interchange format (phase 47A).
 *
 * `.npex` is deliberately separate from NPSL (`.json`) and the `.npsb`
 * recovery archive. It carries ONE measured concentration–time dataset, its
 * declared units, ordered measurements, import provenance and optional notes.
 * It never carries local database ids, timestamps or the Dexie record shape:
 * importing assigns a new local dataset/measurement identity.
 *
 * Export/import fidelity contract:
 * - name, units (as declared), notes, provenance, source row order,
 *   `sourceRow`, numeric time/concentration values, optional sample ids and
 *   measurement notes round-trip exactly;
 * - no averaging, sorting, deduplication, interpolation, unit conversion or
 *   other scientific transformation happens at this boundary.
 *
 * Validation is strict and fail-closed: size limit, duplicate JSON keys,
 * depth, exact envelope/dataset shape, independent semantic version rule,
 * unit dimensions and per-measurement numeric/range checks all run before a
 * caller can write anything. Error paths name the exact measurement.
 *
 * Pure data module: no React, no Dexie, no DOM.
 */
import { z } from 'zod'
import {
  MAX_DATASET_MEASUREMENTS,
  concentrationUnitIssue,
  declaredUnit,
  normalizeDatasetName,
  normalizeDatasetNotes,
  normalizeMeasurementNote,
  normalizeSampleId,
  timeUnitIssue,
  type ExperimentalDataset,
  type ExperimentalDatasetInput,
  type ExperimentalMeasurementInput,
  type AdministrationMetadata,
} from '../../domain/experiments/experimental-dataset'
import { experimentalDatasetNpexSchema } from '../schemas/experimentalDatasets'
import { scanDuplicateJsonKeys } from '../recovery/duplicateKeys'
import { exceedsUtf8ByteLimit } from '../recovery/fidelity'

export const NPEX_FORMAT_ID = 'npex'
export const NPEX_VERSION = '1.1.0'
export const NPEX_EXTENSION = '.npex'
export const NPEX_MIME_TYPE = 'application/json;charset=utf-8'
export const MAX_NPEX_BYTES = 10 * 1024 * 1024
const NPEX_MAX_DEPTH = 100

export type NpexIssueCode =
  | 'NPEX_TOO_LARGE'
  | 'NPEX_DUPLICATE_JSON_KEY'
  | 'NPEX_TOO_DEEP'
  | 'NPEX_PARSE'
  | 'NPEX_ENVELOPE'
  | 'NPEX_VERSION'
  | 'NPEX_VALIDATION'
  | 'NPEX_EXPORT_VALIDATION'
  | 'NPEX_EXPORT_TOO_LARGE'

export interface NpexIssue {
  readonly code: NpexIssueCode
  /** Dot path inside the file, e.g. `dataset.measurements[2].time`. */
  readonly path?: string
  readonly message: string
}

export type NpexParseResult =
  | {
      readonly ok: true
      readonly dataset: ExperimentalDatasetInput
      readonly exportedAt: string
    }
  | { readonly ok: false; readonly issues: readonly NpexIssue[] }

export type NpexBuildResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly issues: readonly NpexIssue[] }

const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)) && /T\d{2}:\d{2}:\d{2}/.test(value), {
    message: 'must be an ISO 8601 date-time string',
  })

const envelopeSchema = z.strictObject({
  formatId: z.literal(NPEX_FORMAT_ID),
  formatVersion: z.string(),
  exportedAt: isoDateTime,
  dataset: z.unknown(),
})

/** Independent semantic-version rule (not shared with `.npsb`/NPSL). */
export function checkNpexVersion(candidate: string):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string } {
  if (!/^\d+\.\d+\.\d+$/.test(candidate)) {
    return { ok: false, reason: `version "${candidate}" is not a valid semantic version` }
  }
  const [cMajor = Number.NaN, cMinor = Number.NaN] = candidate.split('.').map(Number)
  const [rMajor = Number.NaN, rMinor = Number.NaN] = NPEX_VERSION.split('.').map(Number)
  if (cMajor !== rMajor) {
    return {
      ok: false,
      reason: `Major version ${cMajor} is not supported (this build reads major version ${rMajor}).`,
    }
  }
  if (cMinor > rMinor) {
    return {
      ok: false,
      reason: `Version ${candidate} is newer than supported ${NPEX_VERSION}; update the application to import this file.`,
    }
  }
  return { ok: true }
}

function issue(code: NpexIssueCode, message: string, path?: string): NpexIssue {
  return path === undefined ? { code, message } : { code, path, message }
}

function zodIssues(error: z.ZodError, prefix: string, code: NpexIssueCode): NpexIssue[] {
  return error.issues.map((entry) => {
    const path = entry.path.length === 0 ? prefix : `${prefix}.${entry.path.join('.')}`
    return issue(code, entry.message, path)
  })
}

function measurementFromParsed(
  parsed: z.infer<typeof experimentalDatasetNpexSchema>['measurements'][number],
  index: number,
  issues: NpexIssue[],
): ExperimentalMeasurementInput | null {
  const sample = normalizeSampleId(parsed.sampleId)
  if (!sample.ok) {
    issues.push(issue('NPEX_VALIDATION', sample.message, `dataset.measurements[${index}].sampleId`))
    return null
  }
  const note = normalizeMeasurementNote(parsed.note)
  if (!note.ok) {
    issues.push(issue('NPEX_VALIDATION', note.message, `dataset.measurements[${index}].note`))
    return null
  }
  return {
    sourceRow: parsed.sourceRow,
    time: Object.is(parsed.time, -0) ? 0 : parsed.time,
    concentration: Object.is(parsed.concentration, -0) ? 0 : parsed.concentration,
    ...(sample.sampleId === undefined ? {} : { sampleId: sample.sampleId }),
    ...(note.note === undefined ? {} : { note: note.note }),
  }
}

/**
 * Parse and validate `.npex` text read-only. No local identity or timestamp is
 * invented here; the caller (repository) assigns those only after a successful
 * preview and explicit confirmation.
 */
export function parseNpexText(text: string): NpexParseResult {
  if (exceedsUtf8ByteLimit(text, MAX_NPEX_BYTES)) {
    return {
      ok: false,
      issues: [
        issue(
          'NPEX_TOO_LARGE',
          `the file exceeds the limit of ${MAX_NPEX_BYTES} UTF-8 bytes (10 MiB)`,
        ),
      ],
    }
  }

  const duplicateScan = scanDuplicateJsonKeys(text, NPEX_MAX_DEPTH)
  if (!duplicateScan.ok && duplicateScan.reason === 'duplicate') {
    return {
      ok: false,
      issues: [
        issue(
          'NPEX_DUPLICATE_JSON_KEY',
          `duplicate JSON object key "${duplicateScan.key}" at line ${duplicateScan.line}, column ${duplicateScan.column} — JSON.parse would silently keep only the last value`,
        ),
      ],
    }
  }
  if (!duplicateScan.ok && duplicateScan.reason === 'depth') {
    return {
      ok: false,
      issues: [
        issue('NPEX_TOO_DEEP', `the JSON structure nests deeper than the limit of ${NPEX_MAX_DEPTH}`),
      ],
    }
  }

  let root: unknown
  try {
    root = JSON.parse(text)
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue(
          'NPEX_PARSE',
          `not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    }
  }

  if (typeof root !== 'object' || root === null || Array.isArray(root)) {
    return {
      ok: false,
      issues: [issue('NPEX_ENVELOPE', 'the file root must be a JSON object')],
    }
  }

  const formatId = (root as Record<string, unknown>)['formatId']
  if (formatId !== NPEX_FORMAT_ID) {
    return {
      ok: false,
      issues: [
        issue(
          'NPEX_ENVELOPE',
          `this file does not declare formatId "npex" — it is not an experimental dataset file`,
        ),
      ],
    }
  }

  const candidateVersion = (root as Record<string, unknown>)['formatVersion']
  if (typeof candidateVersion !== 'string') {
    return {
      ok: false,
      issues: [issue('NPEX_VERSION', 'formatVersion must be a semantic version string like "1.0.0"')],
    }
  }
  const compatibility = checkNpexVersion(candidateVersion)
  if (!compatibility.ok) {
    return { ok: false, issues: [issue('NPEX_VERSION', compatibility.reason)] }
  }

  const envelope = envelopeSchema.safeParse(root)
  if (!envelope.success) {
    return { ok: false, issues: zodIssues(envelope.error, '(root)', 'NPEX_ENVELOPE') }
  }

  const dataset = experimentalDatasetNpexSchema.safeParse(envelope.data.dataset)
  if (!dataset.success) {
    return { ok: false, issues: zodIssues(dataset.error, 'dataset', 'NPEX_VALIDATION') }
  }

  const issues: NpexIssue[] = []
  const name = normalizeDatasetName(dataset.data.name)
  if (!name.ok) issues.push(issue('NPEX_VALIDATION', name.message, 'dataset.name'))
  const notes = normalizeDatasetNotes(dataset.data.notes)
  if (!notes.ok) issues.push(issue('NPEX_VALIDATION', notes.message, 'dataset.notes'))
  const timeUnit = declaredUnit(dataset.data.timeUnit)
  const timeIssue = timeUnitIssue(timeUnit)
  if (timeIssue !== null) issues.push(issue('NPEX_VALIDATION', timeIssue, 'dataset.timeUnit'))
  const concentrationUnit = declaredUnit(dataset.data.concentrationUnit)
  const concentrationIssue = concentrationUnitIssue(concentrationUnit)
  if (concentrationIssue !== null) {
    issues.push(issue('NPEX_VALIDATION', concentrationIssue, 'dataset.concentrationUnit'))
  }

  const measurements: ExperimentalMeasurementInput[] = []
  dataset.data.measurements.forEach((measurement, index) => {
    const normalized = measurementFromParsed(measurement, index, issues)
    if (normalized !== null) measurements.push(normalized)
  })
  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    exportedAt: envelope.data.exportedAt,
    dataset: {
      name: name.ok ? name.name : dataset.data.name,
      timeUnit,
      concentrationUnit,
      ...(notes.ok && notes.notes !== undefined ? { notes: notes.notes } : {}),
      provenance: {
        source: dataset.data.provenance.source,
        importedAt: dataset.data.provenance.importedAt,
        ...(dataset.data.provenance.fileName === undefined
          ? {}
          : { fileName: dataset.data.provenance.fileName }),
      },
      ...(dataset.data.administration === undefined
        ? {}
        : { administration: dataset.data.administration as unknown as AdministrationMetadata }),
      measurements,
    },
  }
}

function datasetInputFromStored(dataset: ExperimentalDataset): ExperimentalDatasetInput {
  return {
    name: dataset.name,
    timeUnit: dataset.timeUnit,
    concentrationUnit: dataset.concentrationUnit,
    ...(dataset.notes === undefined ? {} : { notes: dataset.notes }),
    ...(dataset.administration === undefined ? {} : { administration: dataset.administration }),
    provenance: dataset.provenance,
    measurements: dataset.measurements.map((measurement) => ({
      sourceRow: measurement.sourceRow,
      time: measurement.time,
      concentration: measurement.concentration,
      ...(measurement.sampleId === undefined ? {} : { sampleId: measurement.sampleId }),
      ...(measurement.note === undefined ? {} : { note: measurement.note }),
    })),
  }
}

/**
 * Build `.npex` text for one stored dataset. The local id, created/updated
 * timestamps and measurement ids are intentionally not serialized.
 */
export function buildNpexFile(
  dataset: ExperimentalDataset,
  exportedAt: string = new Date().toISOString(),
): NpexBuildResult {
  const input = datasetInputFromStored(dataset)
  const validated = experimentalDatasetNpexSchema.safeParse(input)
  if (!validated.success) {
    return {
      ok: false,
      issues: zodIssues(validated.error, 'dataset', 'NPEX_EXPORT_VALIDATION'),
    }
  }
  if (validated.data.measurements.length > MAX_DATASET_MEASUREMENTS) {
    return {
      ok: false,
      issues: [
        issue(
          'NPEX_EXPORT_VALIDATION',
          `a dataset may contain at most ${MAX_DATASET_MEASUREMENTS} measurements`,
          'dataset.measurements',
        ),
      ],
    }
  }

  const envelope = {
    formatId: NPEX_FORMAT_ID,
    formatVersion: NPEX_VERSION,
    exportedAt,
    dataset: validated.data,
  }
  let text: string
  try {
    text = JSON.stringify(envelope, null, 2)
  } catch (error) {
    return {
      ok: false,
      issues: [
        issue(
          'NPEX_EXPORT_VALIDATION',
          `the dataset could not be serialized: ${error instanceof Error ? error.message : String(error)}`,
        ),
      ],
    }
  }
  if (exceedsUtf8ByteLimit(text, MAX_NPEX_BYTES)) {
    return {
      ok: false,
      issues: [
        issue(
          'NPEX_EXPORT_TOO_LARGE',
          `the exported file would exceed the limit of ${MAX_NPEX_BYTES} UTF-8 bytes (10 MiB)`,
        ),
      ],
    }
  }
  return { ok: true, text }
}
