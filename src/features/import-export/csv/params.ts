/**
 * Shared CSV parameter table — the single source of truth for which
 * scientific parameters the CSV projection covers, how they are columned
 * on export and which unit sources import may accept.
 *
 * Derivation follows `docs/validation.md` §7 and the domain types
 * (`ReceptorTarget` for scope `target`, `Pharmacokinetics` for scope
 * `pk`). Parameter kinds are never inferred from column names: the CSV
 * schema uses these fixed column names on export, and import requires the
 * user to map every column explicitly.
 *
 * `dimensions` declares which unit-catalog dimensions a *fixed* unit
 * policy may pick from for that parameter (the select shown when no unit
 * column is mapped). Parameters without dimensions (clearance, volume of
 * distribution) use derived units the catalog does not enumerate, so their
 * fixed unit is a declared free-text value instead. No conversion is ever
 * applied — the declared unit is stored verbatim.
 */
import type { DimensionId } from '@/domain/pharmacology/units'

export type TargetParamKey = 'kd' | 'ki' | 'ec50' | 'ic50'
export type PkParamKey =
  | 'halfLife'
  | 'clearance'
  | 'volumeOfDistribution'
  | 'bioavailability'
export type ParamKey = TargetParamKey | PkParamKey

export interface CsvParamDef {
  readonly key: ParamKey
  /** Which nested record the value belongs to. */
  readonly scope: 'target' | 'pk'
  /** Column base name (value = `<column>`, unit = `<column>_unit`, ...). */
  readonly column: string
  readonly label: string
  /** Fixed-unit select options by catalog dimension; empty = free-text declaration. */
  readonly dimensions: readonly DimensionId[]
}

export const CSV_PARAMS: readonly CsvParamDef[] = [
  {
    key: 'kd',
    scope: 'target',
    column: 'kd',
    label: 'Kd',
    dimensions: ['molar-concentration', 'mass-concentration'],
  },
  {
    key: 'ki',
    scope: 'target',
    column: 'ki',
    label: 'Ki',
    dimensions: ['molar-concentration', 'mass-concentration'],
  },
  {
    key: 'ec50',
    scope: 'target',
    column: 'ec50',
    label: 'EC50',
    dimensions: ['molar-concentration', 'mass-concentration'],
  },
  {
    key: 'ic50',
    scope: 'target',
    column: 'ic50',
    label: 'IC50',
    dimensions: ['molar-concentration', 'mass-concentration'],
  },
  {
    key: 'halfLife',
    scope: 'pk',
    column: 'half_life',
    label: 'Half-life',
    dimensions: ['time'],
  },
  {
    key: 'clearance',
    scope: 'pk',
    column: 'clearance',
    label: 'Clearance',
    dimensions: [],
  },
  {
    key: 'volumeOfDistribution',
    scope: 'pk',
    column: 'volume_of_distribution',
    label: 'Volume of distribution',
    dimensions: [],
  },
  {
    key: 'bioavailability',
    scope: 'pk',
    column: 'bioavailability',
    label: 'Bioavailability',
    dimensions: ['dimensionless'],
  },
]

/** Narrowed definitions so `target[key]` / `pk[key]` are compile-proven. */
export interface CsvTargetParamDef extends Omit<CsvParamDef, 'key'> {
  readonly key: TargetParamKey
}
export interface CsvPkParamDef extends Omit<CsvParamDef, 'key'> {
  readonly key: PkParamKey
}

export const CSV_TARGET_PARAMS: readonly CsvTargetParamDef[] = CSV_PARAMS.filter(
  (p): p is CsvTargetParamDef => p.scope === 'target',
)
export const CSV_PK_PARAMS: readonly CsvPkParamDef[] = CSV_PARAMS.filter(
  (p): p is CsvPkParamDef => p.scope === 'pk',
)

/** `<column>`, `<column>_unit`, `<column>_provenance_type`, ... */
export function paramColumnNames(param: CsvParamDef): readonly string[] {
  return [
    param.column,
    `${param.column}_unit`,
    `${param.column}_provenance_type`,
    `${param.column}_provenance_source`,
    `${param.column}_provenance_json`,
  ]
}
