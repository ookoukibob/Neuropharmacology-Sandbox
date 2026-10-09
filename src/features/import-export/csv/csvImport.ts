/**
 * CSV import — explicit column mapping → versioned NPSL document.
 *
 * CSV is structurally weaker than NPSL, so nothing is guessed: every
 * source column is mapped by the user to a destination derived from the
 * domain model (`CSV_DESTINATIONS`), a value must have an explicit unit
 * source (its own unit column or a visibly declared fixed unit), and the
 * resulting records are assembled into a real NPSL document that is then
 * validated by the *same* pipeline as any other import
 * (`previewNpslImport` → repository transaction). There is no second,
 * weaker validation path.
 *
 * Scientific-integrity rules enforced here:
 * - a column named `Kd/Ki`, `affinity`, `potency`, ... is never inferred —
 *   ambiguous columns stay unmapped (visible in the preview) until the
 *   user assigns them;
 * - Kd, Ki, EC50 and IC50 are separate destinations; no substitution;
 * - units are stored verbatim — no conversion, no default unit;
 * - provenance is preserved exactly when provided; values without mapped
 *   provenance are stamped `{ type: 'user' }` (never literature);
 * - rows are grouped into one record only through an explicit drug id —
 *   equal names never merge records;
 * - any row-level problem blocks the whole import with per-row messages
 *   (the repository import is all-or-nothing, so partial writes cannot be
 *   expressed anyway).
 *
 * Identity policy: generated ids (`newId()`) are identity bookkeeping only
 * — they are never presented as pharmacological data. Imported records
 * always carry storage `origin: 'imported'`, which stays distinct from
 * scientific provenance.
 */
import { newId } from '@/data/id'
import { toNpslDocument, type NpslDocument } from '@/data/mappers/npslDocument'
import type { Drug, ReceptorTarget, TargetAction } from '@/domain/drug/drug'
import type { LibraryMetadata } from '@/domain/library/library'
import type { Provenance } from '@/domain/provenance/provenance'
import {
  CSV_PARAMS,
  CSV_PK_PARAMS,
  CSV_TARGET_PARAMS,
  type CsvParamDef,
  type ParamKey,
  type PkParamKey,
  type TargetParamKey,
} from './params'

/** One selectable meaning for a source column. */
export interface DestinationOption {
  readonly id: string
  /** Group heading in the mapping select (ordered, de-duplicated). */
  readonly group: string
  readonly label: string
}

/** Every destination the current domain model supports for CSV import. */
export const CSV_DESTINATIONS: readonly DestinationOption[] = [
  { id: 'drug.name', group: 'Drug', label: 'Name (required)' },
  { id: 'drug.id', group: 'Drug', label: 'Drug id' },
  { id: 'drug.synonyms', group: 'Drug', label: 'Synonyms ("; "-separated)' },
  { id: 'drug.description', group: 'Drug', label: 'Description' },
  { id: 'drug.casNumber', group: 'Drug', label: 'CAS number' },
  { id: 'drug.tags', group: 'Drug', label: 'Tags ("; "-separated)' },
  { id: 'drug.notes', group: 'Drug', label: 'Notes' },
  { id: 'drug.createdAt', group: 'Drug', label: 'Created at (ISO 8601)' },
  { id: 'drug.updatedAt', group: 'Drug', label: 'Updated at (ISO 8601)' },
  { id: 'pk.notes', group: 'Drug', label: 'Pharmacokinetic notes' },
  { id: 'target.id', group: 'Target', label: 'Target id' },
  { id: 'target.name', group: 'Target', label: 'Target name' },
  { id: 'target.gene', group: 'Target', label: 'Target gene' },
  { id: 'target.action', group: 'Target', label: 'Target action' },
  { id: 'target.species', group: 'Target', label: 'Target species' },
  { id: 'target.notes', group: 'Target', label: 'Target notes' },
  ...CSV_PARAMS.flatMap((p) => [
    { id: `${p.key}.value`, group: p.label, label: 'Value' },
    { id: `${p.key}.unit`, group: p.label, label: 'Unit' },
    { id: `${p.key}.prov.type`, group: p.label, label: 'Provenance type' },
    { id: `${p.key}.prov.source`, group: p.label, label: 'Provenance source (literature)' },
    { id: `${p.key}.prov.json`, group: p.label, label: 'Provenance JSON' },
  ]),
]

const DESTINATION_LABELS: ReadonlyMap<string, string> = new Map(
  CSV_DESTINATIONS.map((d) => [d.id, `${d.group} → ${d.label}`]),
)

function destinationLabel(id: string): string {
  return DESTINATION_LABELS.get(id) ?? id
}

export interface CsvMappingState {
  readonly fileName: string
  readonly headers: readonly string[]
  readonly rows: readonly (readonly string[])[]
  /** Destination id per column index; `null` = ignored (shown as such). */
  readonly destinations: readonly (string | null)[]
  /** Fixed unit per parameter when no unit column is mapped ('' = none). */
  readonly fixedUnits: Readonly<Partial<Record<ParamKey, string>>>
}

export interface CsvImportContext {
  /** ISO timestamp for bookkeeping stamps and user-provenance `recordedAt`. */
  readonly now: string
  /** Current library metadata (kept across a CSV replace, see `notes`). */
  readonly metadata: LibraryMetadata
}

export interface CsvBuildResult {
  readonly ok: boolean
  /** Mapping- or row-level problems — block the import until fixed. */
  readonly errors: readonly string[]
  /** Visible declarations: grouping, unit policy, provenance, unmapped. */
  readonly notes: readonly string[]
  /** Candidate document — only meaningful when `ok`; must be previewed. */
  readonly document: NpslDocument | null
  readonly rowCount: number
  readonly drugCount: number
}

const TARGET_ACTIONS: readonly TargetAction[] = [
  'agonist',
  'partial-agonist',
  'antagonist',
  'inverse-agonist',
  'modulator',
  'reuptake-inhibitor',
  'unknown',
]

type ProvenanceType = Provenance['type']

/* ------------------------------------------------------------------ */
/* Mapping validation                                                  */
/* ------------------------------------------------------------------ */

function buildColumnIndex(
  destinations: readonly (string | null)[],
): Map<string, number> {
  const columnOf = new Map<string, number>()
  destinations.forEach((dest, index) => {
    if (dest !== null && !columnOf.has(dest)) columnOf.set(dest, index)
  })
  return columnOf
}

/**
 * Structural checks on the mapping itself — nothing about row content.
 * Every returned error is actionable and blocks the preview step.
 */
export function validateMapping(state: CsvMappingState): readonly string[] {
  if (state.destinations.length !== state.headers.length) {
    return ['the mapping table does not match the file columns — reload the file']
  }
  const errors: string[] = []
  if (state.rows.length === 0) {
    errors.push('the file has no data rows — nothing to import.')
  }

  const columnOf = new Map<string, number>()
  state.destinations.forEach((dest, index) => {
    if (dest === null) return
    const existing = columnOf.get(dest)
    if (existing !== undefined) {
      errors.push(
        `columns "${state.headers[existing]}" and "${state.headers[index]}" both map to ${destinationLabel(dest)} — each meaning may be assigned only once.`,
      )
      return
    }
    columnOf.set(dest, index)
  })

  if (!columnOf.has('drug.name')) {
    errors.push('Drug name must be mapped to a column.')
  }

  for (const param of CSV_PARAMS) {
    const value = columnOf.has(`${param.key}.value`)
    const unit = columnOf.has(`${param.key}.unit`)
    const provType = columnOf.has(`${param.key}.prov.type`)
    const provRest =
      columnOf.has(`${param.key}.prov.source`) || columnOf.has(`${param.key}.prov.json`)
    const fixed = (state.fixedUnits[param.key] ?? '').trim()

    if (!value) {
      if (unit) {
        errors.push(
          `a ${param.label} unit column is mapped but the ${param.label} value column is not.`,
        )
      }
      if (provType || provRest) {
        errors.push(
          `provenance columns are mapped for ${param.label} but its value column is not.`,
        )
      }
      if (fixed !== '') {
        errors.push(
          `a fixed unit is chosen for ${param.label} but its value column is not mapped.`,
        )
      }
      continue
    }
    if (provRest && !provType) {
      errors.push(
        `${param.label} provenance source/JSON is mapped but the ${param.label} provenance type column is not.`,
      )
    }
    if (unit && fixed !== '') {
      errors.push(
        `${param.label} has both a unit column and a fixed unit — choose exactly one unit source.`,
      )
    }
    if (!unit && fixed === '') {
      errors.push(
        `${param.label} has no unit source — map a unit column or choose a fixed unit for ${param.label}.`,
      )
    }
  }

  const targetColumnMapped =
    ['target.id', 'target.gene', 'target.action', 'target.species', 'target.notes'].some((d) =>
      columnOf.has(d),
    ) ||
    CSV_TARGET_PARAMS.some((p) =>
      ['value', 'unit', 'prov.type', 'prov.source', 'prov.json'].some((suffix) =>
        columnOf.has(`${p.key}.${suffix}`),
      ),
    )
  if (targetColumnMapped && !columnOf.has('target.name')) {
    errors.push(
      'target fields are mapped but the target name column is not — target rows need a name.',
    )
  }

  return errors
}

/**
 * Non-blocking warnings for the mapping UI itself (shown while mapping,
 * before any preview). These encode cross-parameter consistency rules that
 * only the user can judge — the import never resolves them silently.
 */
export function mappingWarnings(state: CsvMappingState): readonly string[] {
  const warnings: string[] = []
  const mapped = (dest: string): boolean => state.destinations.includes(dest)
  if (mapped('kd.value') && mapped('ki.value')) {
    warnings.push(
      'Both Kd and Ki are mapped for one target — they are distinct quantities, stored as separate values and never substituted for one another. Map both only if they describe different measurements; conflicting literature sources for the same measurement must be resolved before import.',
    )
  }
  return warnings
}

/* ------------------------------------------------------------------ */
/* Row building                                                        */
/* ------------------------------------------------------------------ */

interface ParamDraft {
  readonly value: number
  readonly unit: string
  readonly provenance: Provenance
}

interface TargetDraft {
  readonly id?: string
  readonly name: string
  readonly gene?: string
  readonly action?: TargetAction
  readonly species?: string
  readonly notes?: string
  readonly params: Readonly<Partial<Record<TargetParamKey, ParamDraft>>>
}

interface DrugMeta {
  readonly name: string
  readonly synonyms: readonly string[]
  readonly description?: string
  readonly casNumber?: string
  readonly tags: readonly string[]
  readonly notes?: string
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly pkNotes?: string
  readonly pk: Readonly<Partial<Record<PkParamKey, ParamDraft>>>
}

interface RowDraft {
  /** Explicit drug id from the mapped column (trimmed; '' → undefined). */
  readonly id?: string
  readonly meta: DrugMeta
  readonly target?: TargetDraft
}

const PROVENANCE_TYPES: readonly ProvenanceType[] = [
  'literature',
  'user',
  'calculated',
  'derived',
  'unknown',
]

interface ProvenanceCells {
  readonly type: string
  readonly source: string
  readonly json: string
}

interface ProvenanceBuild {
  /** Absent → caller stamps the declared `{ type: 'user' }` default. */
  readonly provenance?: Provenance
  readonly error?: string
}

/**
 * Build one provenance object from its three mapping cells. The object is
 * assembled from parsed JSON and asserted as `Provenance`; the NPSL schema
 * (`previewNpslImport`) re-validates every field with dotted paths before
 * anything can be written, so a malformed field surfaces as a blocking
 * preview error — never as a half-imported record.
 */
function buildProvenance(cells: ProvenanceCells, label: string): ProvenanceBuild {
  const type = cells.type.trim().toLowerCase()
  const source = cells.source.trim()
  const jsonText = cells.json.trim()

  if (type === '') {
    if (source !== '' || jsonText !== '') {
      return {
        error: `${label}: provenance source/JSON is present but the provenance type is empty.`,
      }
    }
    return {}
  }
  if (!PROVENANCE_TYPES.some((t) => t === type)) {
    return {
      error: `${label}: provenance type "${cells.type.trim()}" is not one of ${PROVENANCE_TYPES.join(', ')}.`,
    }
  }

  let rest: Record<string, unknown> = {}
  if (jsonText !== '') {
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      return { error: `${label}: provenance JSON is not valid JSON.` }
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return { error: `${label}: provenance JSON must be a JSON object.` }
    }
    rest = parsed as Record<string, unknown>
  }

  if (type === 'literature') {
    const jsonSource = typeof rest.source === 'string' ? rest.source.trim() : ''
    const resolved = source !== '' ? source : jsonSource
    if (resolved === '') {
      return { error: `${label}: literature provenance requires a source.` }
    }
    const remainder: Record<string, unknown> = { ...rest }
    delete remainder.source
    return { provenance: { ...remainder, type: 'literature', source: resolved } as Provenance }
  }

  if (source !== '') {
    return {
      error: `${label}: a provenance source column only applies to literature provenance (type is "${type}").`,
    }
  }
  return { provenance: { ...rest, type } as Provenance }
}

function userStamp(now: string): Provenance {
  return { type: 'user', recordedAt: now }
}

function splitList(cell: string): string[] {
  return cell
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part !== '')
}

function orUndefined(value: string): string | undefined {
  return value === '' ? undefined : value
}

interface RowBuild {
  readonly draft?: RowDraft
  readonly errors: readonly string[]
}

function buildRow(
  state: CsvMappingState,
  columnOf: ReadonlyMap<string, number>,
  row: readonly string[],
  index: number,
  now: string,
): RowBuild {
  const errors: string[] = []
  const label = `data row ${index + 1}`
  const cell = (dest: string): string => {
    const col = columnOf.get(dest)
    return col === undefined ? '' : (row[col] ?? '').trim()
  }
  const unitFor = (param: CsvParamDef): string =>
    columnOf.has(`${param.key}.unit`)
      ? cell(`${param.key}.unit`)
      : (state.fixedUnits[param.key] ?? '').trim()

  const name = cell('drug.name')
  if (name === '') errors.push(`${label}: the drug name is required.`)

  const target = buildTarget(cell, unitFor, label, now, errors)
  const pk = buildPk(cell, unitFor, label, now, errors)

  if (errors.length > 0) return { errors }

  const id = orUndefined(cell('drug.id'))
  const description = orUndefined(cell('drug.description'))
  const casNumber = orUndefined(cell('drug.casNumber'))
  const notes = orUndefined(cell('drug.notes'))
  const createdAt = orUndefined(cell('drug.createdAt'))
  const updatedAt = orUndefined(cell('drug.updatedAt'))
  const pkNotes = orUndefined(cell('pk.notes'))

  const meta: DrugMeta = {
    name,
    synonyms: splitList(cell('drug.synonyms')),
    ...(description !== undefined && { description }),
    ...(casNumber !== undefined && { casNumber }),
    tags: splitList(cell('drug.tags')),
    ...(notes !== undefined && { notes }),
    ...(createdAt !== undefined && { createdAt }),
    ...(updatedAt !== undefined && { updatedAt }),
    ...(pkNotes !== undefined && { pkNotes }),
    pk,
  }
  return {
    draft: { ...(id !== undefined && { id }), meta, ...(target !== undefined && { target }) },
    errors: [],
  }
}

function buildTarget(
  cell: (dest: string) => string,
  unitFor: (param: CsvParamDef) => string,
  label: string,
  now: string,
  errors: string[],
): TargetDraft | undefined {
  const name = cell('target.name')
  const gene = orUndefined(cell('target.gene'))
  const species = orUndefined(cell('target.species'))
  const notes = orUndefined(cell('target.notes'))
  const targetId = orUndefined(cell('target.id'))

  let action: TargetAction | undefined
  const actionRaw = cell('target.action')
  if (actionRaw !== '') {
    const match = TARGET_ACTIONS.find((a) => a === actionRaw.toLowerCase())
    if (match !== undefined) {
      action = match
    } else {
      errors.push(
        `${label}: target action "${actionRaw}" is not one of ${TARGET_ACTIONS.join(', ')}.`,
      )
    }
  }

  const params: Partial<Record<TargetParamKey, ParamDraft>> = {}
  let anyParam = false
  for (const param of CSV_TARGET_PARAMS) {
    const built = buildParam(param, cell, unitFor, label, now)
    if (built.error !== undefined) errors.push(built.error)
    else if (built.param !== undefined) {
      params[param.key] = built.param
      anyParam = true
    }
  }

  const hasContent =
    name !== '' ||
    gene !== undefined ||
    action !== undefined ||
    species !== undefined ||
    notes !== undefined ||
    targetId !== undefined ||
    anyParam
  if (!hasContent) return undefined
  if (name === '') {
    errors.push(
      `${label}: target fields are present but the target name is empty — every target needs a name.`,
    )
    return undefined
  }

  return {
    ...(targetId !== undefined && { id: targetId }),
    name,
    ...(gene !== undefined && { gene }),
    ...(action !== undefined && { action }),
    ...(species !== undefined && { species }),
    ...(notes !== undefined && { notes }),
    params,
  }
}

function buildPk(
  cell: (dest: string) => string,
  unitFor: (param: CsvParamDef) => string,
  label: string,
  now: string,
  errors: string[],
): Readonly<Partial<Record<PkParamKey, ParamDraft>>> {
  const pk: Partial<Record<PkParamKey, ParamDraft>> = {}
  for (const param of CSV_PK_PARAMS) {
    const built = buildParam(param, cell, unitFor, label, now)
    if (built.error !== undefined) errors.push(built.error)
    else if (built.param !== undefined) pk[param.key] = built.param
  }
  return pk
}

interface ParamBuild {
  readonly param?: ParamDraft
  readonly error?: string
}

function buildParam(
  param: CsvParamDef,
  cell: (dest: string) => string,
  unitFor: (param: CsvParamDef) => string,
  label: string,
  now: string,
): ParamBuild {
  const pretty = `${label}: ${param.label}`
  const valueRaw = cell(`${param.key}.value`)
  const typeCell = cell(`${param.key}.prov.type`)
  const sourceCell = cell(`${param.key}.prov.source`)
  const jsonCell = cell(`${param.key}.prov.json`)

  if (valueRaw === '') {
    const unitCell = cell(`${param.key}.unit`)
    if (unitCell !== '') return { error: `${pretty} has a unit but no value.` }
    if (typeCell !== '' || sourceCell !== '' || jsonCell !== '') {
      return { error: `${pretty} has provenance but no value.` }
    }
    return {}
  }

  const value = Number(valueRaw)
  if (!Number.isFinite(value)) {
    return { error: `${pretty} value "${valueRaw}" is not a finite number.` }
  }

  const unit = unitFor(param)
  if (unit === '') {
    return { error: `${pretty} has no unit value in its unit column.` }
  }

  const provenance = buildProvenance(
    { type: typeCell, source: sourceCell, json: jsonCell },
    pretty,
  )
  if (provenance.error !== undefined) return { error: provenance.error }

  return { param: { value, unit, provenance: provenance.provenance ?? userStamp(now) } }
}

/* ------------------------------------------------------------------ */
/* Grouping and document assembly                                      */
/* ------------------------------------------------------------------ */

interface Group {
  readonly id?: string
  readonly meta: DrugMeta
  readonly targets: TargetDraft[]
  readonly rows: number[]
}

/** Same-key-order signature: identical metas serialize identically. */
function metaSignature(meta: DrugMeta): string {
  return JSON.stringify(meta)
}

export function buildCsvImport(
  state: CsvMappingState,
  context: CsvImportContext,
): CsvBuildResult {
  const rowCount = state.rows.length
  const mappingErrors = validateMapping(state)
  if (mappingErrors.length > 0) {
    return {
      ok: false,
      errors: mappingErrors,
      notes: [],
      document: null,
      rowCount,
      drugCount: 0,
    }
  }

  const columnOf = buildColumnIndex(state.destinations)
  const idColumnMapped = columnOf.has('drug.id')

  const rowErrors: string[] = []
  const drafts: { row: number; draft: RowDraft }[] = []
  state.rows.forEach((row, index) => {
    const built = buildRow(state, columnOf, row, index, context.now)
    rowErrors.push(...built.errors)
    if (built.draft !== undefined) drafts.push({ row: index + 1, draft: built.draft })
  })
  if (rowErrors.length > 0) {
    return {
      ok: false,
      errors: rowErrors,
      notes: [],
      document: null,
      rowCount,
      drugCount: 0,
    }
  }

  const groupErrors: string[] = []
  const groups: Group[] = []
  const groupByExplicitId = new Map<string, number>()
  for (const { row, draft } of drafts) {
    const explicitId = draft.id
    if (explicitId === undefined) {
      // No id on this row: its own record (ids are generated at assembly).
      groups.push({ meta: draft.meta, targets: targetList(draft), rows: [row] })
      continue
    }
    const existingIndex = groupByExplicitId.get(explicitId)
    if (existingIndex === undefined) {
      groupByExplicitId.set(explicitId, groups.length)
      groups.push({ id: explicitId, meta: draft.meta, targets: targetList(draft), rows: [row] })
      continue
    }
    const group = groups[existingIndex]!
    if (metaSignature(group.meta) !== metaSignature(draft.meta)) {
      groupErrors.push(
        `rows ${group.rows[0]} and ${row} share the drug id "${explicitId}" but their drug-level fields differ — identical ids must repeat identical drug values (leave the id empty for separate records).`,
      )
      continue
    }
    for (const target of targetList(draft)) {
      if (target.id !== undefined && group.targets.some((t) => t.id === target.id)) {
        groupErrors.push(
          `rows ${group.rows[0]} and ${row} repeat the target id "${target.id}" within drug id "${explicitId}" — target ids must be unique inside one record.`,
        )
        continue
      }
      group.targets.push(target)
    }
    group.rows.push(row)
  }
  if (groupErrors.length > 0) {
    return {
      ok: false,
      errors: groupErrors,
      notes: [],
      document: null,
      rowCount,
      drugCount: 0,
    }
  }

  const drugs: Drug[] = groups.map((group) => assembleDrug(group))
  const metadata: LibraryMetadata = {
    ...context.metadata,
    updatedAt: context.now,
    dataStatus: 'user',
  }
  const document = toNpslDocument({ metadata, drugs })

  return {
    ok: true,
    errors: [],
    notes: buildNotes(state, columnOf, idColumnMapped),
    document,
    rowCount,
    drugCount: drugs.length,
  }
}

function targetList(draft: RowDraft): TargetDraft[] {
  return draft.target === undefined ? [] : [draft.target]
}

function assembleDrug(group: Group): Drug {
  const meta = group.meta
  const targets: ReceptorTarget[] = group.targets.map((target) => ({
    id: target.id ?? newId(),
    name: target.name,
    ...(target.gene !== undefined && { gene: target.gene }),
    ...(target.action !== undefined && { action: target.action }),
    ...(target.species !== undefined && { species: target.species }),
    ...(target.notes !== undefined && { notes: target.notes }),
    ...target.params,
  }))
  return {
    id: group.id ?? newId(),
    origin: 'imported',
    identifiers: {
      name: meta.name,
      synonyms: meta.synonyms,
      ...(meta.description !== undefined && { description: meta.description }),
      ...(meta.casNumber !== undefined && { casNumber: meta.casNumber }),
    },
    tags: meta.tags,
    targets,
    pharmacokinetics: {
      ...meta.pk,
      ...(meta.pkNotes !== undefined && { notes: meta.pkNotes }),
    },
    ...(meta.notes !== undefined && { notes: meta.notes }),
    ...(meta.createdAt !== undefined && { createdAt: meta.createdAt }),
    ...(meta.updatedAt !== undefined && { updatedAt: meta.updatedAt }),
  }
}

/** Visible declarations shown next to the preview (never silent rules). */
function buildNotes(
  state: CsvMappingState,
  columnOf: ReadonlyMap<string, number>,
  idColumnMapped: boolean,
): string[] {
  const notes: string[] = []
  notes.push(
    idColumnMapped
      ? 'Rows that share the same drug id become one record with multiple target rows; rows with an empty id become separate records with generated ids.'
      : 'No drug id column is mapped: each data row becomes its own record with a generated id — records with equal names are kept separate, never merged.',
  )
  for (const param of CSV_PARAMS) {
    if (!columnOf.has(`${param.key}.value`)) continue
    const unitColumn = columnOf.get(`${param.key}.unit`)
    if (unitColumn !== undefined) {
      notes.push(`${param.label} unit: from column "${state.headers[unitColumn] ?? 'unnamed'}".`)
    } else {
      notes.push(
        `${param.label} unit: fixed "${(state.fixedUnits[param.key] ?? '').trim()}" — declared unit policy; units are stored verbatim, never converted.`,
      )
    }
  }
  const anyValue = CSV_PARAMS.some((p) => columnOf.has(`${p.key}.value`))
  if (anyValue) {
    notes.push(
      'Provenance not supplied by mapped provenance columns is stamped { "type": "user" } at import time — provenance is never invented or upgraded.',
    )
  }
  notes.push(
    'Imported records are stored with origin "imported" (storage origin, distinct from scientific provenance).',
  )
  notes.push(
    "CSV files carry no library metadata: on Replace the current library's name and id are kept and data status becomes \"user\".",
  )
  const unmapped = state.headers.filter((_, index) => state.destinations[index] === null)
  if (unmapped.length > 0) {
    notes.push(
      `Not imported (columns left unmapped): ${unmapped.map((h) => `"${h}"`).join(', ')}.`,
    )
  }
  return notes
}
