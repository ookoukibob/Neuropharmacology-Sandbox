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
 * CSV is a lossy projection (unknown forward-compat fields are dropped,
 * CSV import re-stamps `origin` and bookkeeping timestamps) — `.npsl`
 * remains the lossless backup/interchange format. Nothing here mutates
 * the library: this is a pure function of an exported `DrugLibrary`.
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
import { toCsv } from './writeCsv'

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
  return values.join('; ')
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
  return [provenance.type, source, json]
}

/** `[value, unit, provenance type, provenance source, provenance json]`. */
function scientificCells(value: MaybeScientificValue): [string, string, string, string, string] {
  if (value === undefined) return ['', '', '', '', '']
  const [type, source, json] = provenanceCells(value.provenance)
  return [String(value.value), value.unit, type, source, json]
}

function drugLevelCells(drug: Drug): string[] {
  return [
    drug.id,
    drug.origin,
    drug.identifiers.name,
    listCell(drug.identifiers.synonyms),
    drug.identifiers.description ?? '',
    drug.identifiers.casNumber ?? '',
    listCell(drug.tags),
    drug.notes ?? '',
    drug.createdAt ?? '',
    drug.updatedAt ?? '',
  ]
}

function targetCells(target: ReceptorTarget | undefined): string[] {
  return [
    target?.id ?? '',
    target?.name ?? '',
    target?.gene ?? '',
    target?.action ?? '',
    target?.species ?? '',
    target?.notes ?? '',
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
      drug.pharmacokinetics.notes ?? '',
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
