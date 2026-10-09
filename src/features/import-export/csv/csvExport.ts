/**
 * CSV export — a flattened projection of the drug library.
 *
 * Schema follows `docs/validation.md` §7 and is **stable**: the header is
 * fixed (see `CSV_HEADERS`) and derived from `CSV_PARAMS`, so consumer
 * spreadsheets and the CSV importer agree on column meaning. One row per
 * target; a drug without targets produces one row with empty target
 * columns; drug-level columns repeat on every row of that drug and rows
 * are tied together by `drug_id`.
 *
 * Provenance is split into companion columns per parameter: `<p>` (value),
 * `<p>_unit`, `<p>_provenance_type`, `<p>_provenance_source` and
 * `<p>_provenance_json` (the remaining provenance fields as a JSON string,
 * e.g. citation/doi/notes). Storage `origin` is a plain column and stays
 * distinct from scientific provenance.
 *
 * Spreadsheet formula injection: every cell built from text (ids, names,
 * notes, units, enums, timestamps, provenance cells) is passed through
 * `protectAgainstFormulaInjection` before the writer's RFC-4180 quoting,
 * so a dangerous text cell from an imported record is stored with a
 * leading apostrophe instead of being executed when the CSV is opened.
 * Numeric value cells deliberately bypass the guard: they are serialized
 * with `String(finite number)`, which can only produce a numeric literal
 * (digits, `.`, `e±`, leading `-`) — a spreadsheet parses that as a
 * number, never as a command, and guarding would corrupt legitimate
 * negative values such as `-2.5`. Text transformations happen only in
 * this export representation — the library and its records are never
 * modified (this is a pure function of an exported `DrugLibrary`).
 *
 * CSV is a lossy projection (unknown forward-compat fields are dropped,
 * CSV import re-stamps `origin` and bookkeeping timestamps, and a
 * re-import keeps the formula guard's apostrophe on formerly dangerous
 * cells) — `.npsl` remains the lossless backup/interchange format.
 */
import type { Drug, ReceptorTarget } from '@/domain/drug/drug'
import type { DrugLibrary } from '@/domain/library/library'
import type { MaybeScientificValue } from '@/domain/pharmacology/scientific-value'
import type { Provenance } from '@/domain/provenance/provenance'
import {
  CSV_PK_PARAMS,
  CSV_TARGET_PARAMS,
  paramColumnNames,
} from './params'
import { protectAgainstFormulaInjection, toCsv } from './writeCsv'

/**
 * One text cell: guarded against spreadsheet formula injection before the
 * writer's quoting. Every text-derived cell (ids, labels, notes, units,
 * enum cells, timestamps, provenance strings) goes through here because
 * any of them can originate from an imported file. Numeric value cells
 * never do — see the module comment.
 */
function textCell(value: string): string {
  return protectAgainstFormulaInjection(value)
}

/** Drug-level columns (identity, bookkeeping, notes). */
const DRUG_COLUMNS: readonly string[] = [
  'drug_id',
  'origin',
  'name',
  'synonyms',
  'description',
  'cas_number',
  'tags',
  'notes',
  'created_at',
  'updated_at',
]

/** Target-level columns (identity + descriptor fields). */
const TARGET_COLUMNS: readonly string[] = [
  'target_id',
  'target_name',
  'target_gene',
  'target_action',
  'target_species',
  'target_notes',
]

/** Pharmacokinetic notes column, between the target and PK parameter blocks. */
const PK_NOTES_COLUMN = 'pk_notes'

/** The full, stable CSV header (one row per target). */
export const CSV_HEADERS: readonly string[] = [
  ...DRUG_COLUMNS,
  ...TARGET_COLUMNS,
  ...CSV_TARGET_PARAMS.flatMap((p) => paramColumnNames(p)),
  PK_NOTES_COLUMN,
  ...CSV_PK_PARAMS.flatMap((p) => paramColumnNames(p)),
]

function listCell(values: readonly string[]): string {
  // Guarded at cell granularity: the whole joined cell is one spreadsheet
  // cell, and only a *leading* trigger can cause evaluation.
  return textCell(values.join('; '))
}

/** Provenance → `[type, source, json]` companion cells. */
function provenanceCells(provenance: Provenance | undefined): [string, string, string] {
  if (provenance === undefined) return ['', '', '']
  const rest: Record<string, unknown> = { ...provenance }
  delete rest.type
  let source = ''
  if (provenance.type === 'literature') {
    source = provenance.source
    delete rest.source
  }
  const json = Object.keys(rest).length > 0 ? JSON.stringify(rest) : ''
  return [textCell(provenance.type), textCell(source), textCell(json)]
}

/** `[value, unit, provenance type, provenance source, provenance json]`. */
function scientificCells(value: MaybeScientificValue): [string, string, string, string, string] {
  if (value === undefined) return ['', '', '', '', '']
  const [type, source, json] = provenanceCells(value.provenance)
  // The value cell is numeric by schema (`finite number`): emitted with
  // String() and deliberately NOT formula-guarded, so `-2.5`, `0` and
  // `1e-9` survive byte-exact (see the module comment).
  return [String(value.value), textCell(value.unit), type, source, json]
}

function drugLevelCells(drug: Drug): string[] {
  return [
    textCell(drug.id),
    textCell(drug.origin),
    textCell(drug.identifiers.name),
    listCell(drug.identifiers.synonyms),
    textCell(drug.identifiers.description ?? ''),
    textCell(drug.identifiers.casNumber ?? ''),
    listCell(drug.tags),
    textCell(drug.notes ?? ''),
    textCell(drug.createdAt ?? ''),
    textCell(drug.updatedAt ?? ''),
  ]
}

function targetCells(target: ReceptorTarget | undefined): string[] {
  return [
    textCell(target?.id ?? ''),
    textCell(target?.name ?? ''),
    textCell(target?.gene ?? ''),
    textCell(target?.action ?? ''),
    textCell(target?.species ?? ''),
    textCell(target?.notes ?? ''),
  ]
}

/** One row per target; a drug without targets still yields a row. */
function rowsForDrug(drug: Drug): string[][] {
  const targets: readonly (ReceptorTarget | undefined)[] =
    drug.targets.length > 0 ? drug.targets : [undefined]
  return targets.map((target) => {
    const row: string[] = [
      ...drugLevelCells(drug),
      ...targetCells(target),
      ...CSV_TARGET_PARAMS.flatMap((p) => scientificCells(target?.[p.key])),
      textCell(drug.pharmacokinetics.notes ?? ''),
      ...CSV_PK_PARAMS.flatMap((p) => scientificCells(drug.pharmacokinetics[p.key])),
    ]
    return row
  })
}

/** Flatten a library into CSV data rows (one per target). */
export function libraryToCsvRows(library: DrugLibrary): string[][] {
  const rows: string[][] = []
  for (const drug of library.drugs) rows.push(...rowsForDrug(drug))
  return rows
}

/** Serialize the whole library as CSV text (stable header, CRLF records). */
export function libraryToCsv(library: DrugLibrary): string {
  return toCsv(CSV_HEADERS, libraryToCsvRows(library))
}
