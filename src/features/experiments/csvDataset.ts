/**
 * CSV → experimental dataset import (phase 47A).
 *
 * The CSV importer is intentionally strict and never guesses:
 * - every column is mapped explicitly; time and concentration columns and
 *   their units are required, and optional sample/note columns are explicit;
 * - numbers must be plain decimal/scientific literals after trimming. Blank
 *   cells, qualifiers (`<0.1`, `>5`), below-limit markers (`BLQ`), missing
 *   markers (`N/A`, `NA`, `-`) and any other text are rejected with the data
 *   row number — never coerced or skipped;
 * - negative and non-finite values are rejected; zero is valid;
 * - rows are kept in source order and every row is kept. Duplicate timestamps,
 *   duplicate sample ids and exact replicates are data, not errors.
 *
 * The result is a validated `ExperimentalDatasetInput`; this module performs
 * no writes. The UI previews it and only the user's confirmation calls the
 * repository (which validates again inside its transaction).
 */
import {
  MAX_DATASET_MEASUREMENTS,
  concentrationUnitIssue,
  declaredUnit,
  normalizeDatasetName,
  normalizeDatasetNotes,
  normalizeMeasurementNote,
  normalizeSampleId,
  timeUnitIssue,
  type ExperimentalDatasetInput,
  type ExperimentalMeasurementInput,
} from '@/domain/experiments/experimental-dataset'
import { experimentalDatasetInputSchema } from '@/data/schemas/experimentalDatasets'
import { exceedsUtf8ByteLimit } from '@/data/recovery/fidelity'
import { parseCsv, type CsvTable } from '@/features/import-export/csv/parseCsv'

export const MAX_CSV_BYTES = 10 * 1024 * 1024

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

export interface CsvDatasetMapping {
  readonly datasetName: string
  readonly notes: string
  readonly timeColumn: number | null
  readonly timeUnit: string
  readonly concentrationColumn: number | null
  readonly concentrationUnit: string
  readonly sampleColumn: number | null
  readonly noteColumn: number | null
}

export interface CsvDatasetIssue {
  /** 1-based DATA row (header excluded); absent for mapping/file issues. */
  readonly row?: number
  /** Source column header or destination field. */
  readonly column?: string
  readonly message: string
}

export interface CsvDatasetPreview {
  readonly rowCount: number
  readonly validRowCount: number
  readonly invalidRowCount: number
  readonly issues: readonly CsvDatasetIssue[]
  /** Present only when every row is valid (all-or-nothing). */
  readonly dataset?: ExperimentalDatasetInput
}

export type CsvReadResult =
  | { readonly ok: true; readonly table: CsvTable }
  | { readonly ok: false; readonly error: string }

/** Parse a CSV file with the shared RFC 4180 reader, adding size/row limits. */
export function readExperimentalCsv(text: string): CsvReadResult {
  if (exceedsUtf8ByteLimit(text, MAX_CSV_BYTES)) {
    return {
      ok: false,
      error: `the file exceeds the limit of ${MAX_CSV_BYTES} UTF-8 bytes (10 MiB)`,
    }
  }
  const parsed = parseCsv(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  if (parsed.table.rows.length === 0) {
    return { ok: false, error: 'the file has a header but no data rows' }
  }
  if (parsed.table.rows.length > MAX_DATASET_MEASUREMENTS) {
    return {
      ok: false,
      error: `the file has ${parsed.table.rows.length.toLocaleString('en-US')} data rows; the limit is ${MAX_DATASET_MEASUREMENTS.toLocaleString('en-US')}`,
    }
  }
  return { ok: true, table: parsed.table }
}

function parseNumber(
  raw: string,
  label: string,
  row: number,
  column: string,
): { readonly ok: true; readonly value: number } | { readonly ok: false; readonly issue: CsvDatasetIssue } {
  const text = raw.trim()
  if (text === '') {
    return {
      ok: false,
      issue: { row, column, message: `data row ${row}: ${label} is blank — a measured number is required` },
    }
  }
  if (!DECIMAL_NUMBER.test(text)) {
    return {
      ok: false,
      issue: {
        row,
        column,
        message: `data row ${row}: ${label} "${raw}" is not a plain decimal number. Qualifiers and markers such as "<0.1", "BLQ", "N/A" and ranges are not accepted; leave the value out only by correcting the source file.`,
      },
    }
  }
  const value = Number(text)
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      issue: {
        row,
        column,
        message: `data row ${row}: ${label} "${raw}" is not a finite number`,
      },
    }
  }
  if (value < 0) {
    return {
      ok: false,
      issue: {
        row,
        column,
        message: `data row ${row}: ${label} "${raw}" is negative; measured time and concentration must be zero or greater`,
      },
    }
  }
  return { ok: true, value: Object.is(value, -0) ? 0 : value }
}

/**
 * Validate an explicit mapping against parsed CSV rows. All problems are
 * collected with row/column context; when any problem remains, no dataset is
 * returned and nothing can be committed.
 */
export function buildDatasetFromCsv(
  table: CsvTable,
  mapping: CsvDatasetMapping,
  fileName: string,
  importedAt: string = new Date().toISOString(),
): CsvDatasetPreview {
  const issues: CsvDatasetIssue[] = []
  const rowCount = table.rows.length
  const columnName = (index: number | null): string | undefined =>
    index === null ? undefined : table.headers[index]

  const name = normalizeDatasetName(mapping.datasetName)
  if (!name.ok) issues.push({ column: 'dataset name', message: name.message })
  const notes = normalizeDatasetNotes(mapping.notes)
  if (!notes.ok) issues.push({ column: 'notes', message: notes.message })

  const timeUnit = declaredUnit(mapping.timeUnit)
  const timeIssue = timeUnitIssue(timeUnit)
  if (timeIssue !== null) issues.push({ column: 'time unit', message: timeIssue })
  const concentrationUnit = declaredUnit(mapping.concentrationUnit)
  const concentrationIssue = concentrationUnitIssue(concentrationUnit)
  if (concentrationIssue !== null) {
    issues.push({ column: 'concentration unit', message: concentrationIssue })
  }

  const selectedColumns = [
    mapping.timeColumn,
    mapping.concentrationColumn,
    mapping.sampleColumn,
    mapping.noteColumn,
  ].filter((index): index is number => index !== null)
  if (new Set(selectedColumns).size !== selectedColumns.length) {
    issues.push({
      column: 'column mapping',
      message: 'each source column can be mapped to only one destination',
    })
  }
  for (const [label, index] of [
    ['time', mapping.timeColumn],
    ['concentration', mapping.concentrationColumn],
  ] as const) {
    if (index === null) {
      issues.push({ column: label, message: `a ${label} column must be selected` })
    } else if (index < 0 || index >= table.headers.length) {
      issues.push({ column: label, message: `the selected ${label} column does not exist` })
    }
  }
  for (const [label, index] of [
    ['sample id', mapping.sampleColumn],
    ['measurement note', mapping.noteColumn],
  ] as const) {
    if (index !== null && (index < 0 || index >= table.headers.length)) {
      issues.push({ column: label, message: `the selected ${label} column does not exist` })
    }
  }

  const file = fileName.trim()
  if (file === '') issues.push({ message: 'the source file name is required for provenance' })
  if (issues.length > 0) {
    return {
      rowCount,
      validRowCount: 0,
      invalidRowCount: rowCount,
      issues,
    }
  }
  // Narrow after the block above; every mapping index is now valid and present.
  const timeColumn = mapping.timeColumn as number
  const concentrationColumn = mapping.concentrationColumn as number
  const measurements: ExperimentalMeasurementInput[] = []
  let invalidRows = 0

  table.rows.forEach((row, index) => {
    const sourceRow = index + 1
    const rowIssues: CsvDatasetIssue[] = []
    const time = parseNumber(
      row[timeColumn] ?? '',
      'time',
      sourceRow,
      table.headers[timeColumn] ?? `column ${timeColumn + 1}`,
    )
    if (!time.ok) rowIssues.push(time.issue)
    const concentration = parseNumber(
      row[concentrationColumn] ?? '',
      'concentration',
      sourceRow,
      table.headers[concentrationColumn] ?? `column ${concentrationColumn + 1}`,
    )
    if (!concentration.ok) rowIssues.push(concentration.issue)

    let sampleId: string | undefined
    if (mapping.sampleColumn !== null) {
      const sample = normalizeSampleId(row[mapping.sampleColumn])
      if (!sample.ok) {
        const column = columnName(mapping.sampleColumn)
        rowIssues.push({
          row: sourceRow,
          ...(column === undefined ? {} : { column }),
          message: `data row ${sourceRow}: ${sample.message}`,
        })
      } else {
        sampleId = sample.sampleId
      }
    }
    let note: string | undefined
    if (mapping.noteColumn !== null) {
      const normalized = normalizeMeasurementNote(row[mapping.noteColumn])
      if (!normalized.ok) {
        const column = columnName(mapping.noteColumn)
        rowIssues.push({
          row: sourceRow,
          ...(column === undefined ? {} : { column }),
          message: `data row ${sourceRow}: ${normalized.message}`,
        })
      } else {
        note = normalized.note
      }
    }

    if (rowIssues.length > 0) {
      invalidRows += 1
      issues.push(...rowIssues)
      return
    }
    if (!time.ok || !concentration.ok) {
      /* c8 ignore next -- unreachable: either failure was pushed above */
      return
    }
    measurements.push({
      sourceRow,
      time: time.value,
      concentration: concentration.value,
      ...(sampleId === undefined ? {} : { sampleId }),
      ...(note === undefined ? {} : { note }),
    })
  })

  if (issues.length > 0) {
    return {
      rowCount,
      validRowCount: rowCount - invalidRows,
      invalidRowCount: invalidRows,
      issues,
    }
  }

  const dataset: ExperimentalDatasetInput = {
    name: name.ok ? name.name : mapping.datasetName,
    timeUnit,
    concentrationUnit,
    measurements,
    provenance: { source: 'csv', fileName: file, importedAt },
    ...(notes.ok && notes.notes !== undefined ? { notes: notes.notes } : {}),
  }
  const finalCheck = experimentalDatasetInputSchema.safeParse(dataset)
  if (!finalCheck.success) {
    return {
      rowCount,
      validRowCount: 0,
      invalidRowCount: rowCount,
      issues: finalCheck.error.issues.map((entry) => ({
        column: entry.path.join('.'),
        message: entry.message,
      })),
    }
  }
  return {
    rowCount,
    validRowCount: rowCount,
    invalidRowCount: 0,
    issues: [],
    dataset,
  }
}
