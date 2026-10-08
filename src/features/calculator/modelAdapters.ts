/**
 * Model adapter registry (phase 4): the small, explicit layer between form
 * drafts and the scientific engine.
 *
 * Each of the three registered models contributes:
 *  - field specs (symbol/label/unit selector/library candidates) that drive
 *    the generic input form — labels are the engine registry's own;
 *  - a draft → engine-input builder that attaches provenance ONLY when the
 *    value was explicitly loaded from a library record (never for typed
 *    values, never upgraded);
 *  - the calculate/curve calls, which are thin re-exports of the engine
 *    functions (no pharmacology is written here).
 *
 * The registry does not decide anything scientific: which values may feed
 * which parameter is enforced by the engine input types (Kd is Kd; Ki and
 * IC50 have no field), and candidate lists never auto-select.
 */
import type { DimensionId } from '../../domain/pharmacology/units'
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import type { Drug } from '../../domain/drug/drug'
import type { Provenance } from '../../domain/provenance/provenance'
import type {
  CalculationError,
  CalculationReport,
  CurveGenerationResult,
  CurveOptions,
  EngineParameter,
  ModelId,
} from '../../engine'
import {
  MODELS,
  calculateFirstOrderPK,
  type FirstOrderPKInput,
  generatePKCurve,
  calculateReceptorOccupancy,
  type ReceptorOccupancyInput,
  generateOccupancyCurve,
  calculateHillResponse,
  type HillResponseInput,
  generateHillCurve,
  dimensionLabel,
  CONCENTRATION_DIMENSIONS,
  TIME_DIMENSIONS,
} from '../../engine'
import {
  type CalculatorDraft,
  type FirstOrderPKCalculatorInput,
  type ReceptorOccupancyCalculatorInput,
  type HillResponseCalculatorInput,
  type ParameterDraft,
} from './schemas'
export type { CalculatorDraft, ParameterDraft } from './schemas'

// --- Library candidate for a calculator field ---

export interface LibraryCandidate {
  /** Stable key for the select option (targetId:paramKind or 'pk:halfLife'). */
  readonly key: string
  /** Human-readable label shown in the select, e.g. "TEST-R · Kd". */
  readonly label: string
  readonly value: number
  readonly unit: string
  readonly provenance: Provenance
}

// --- Unit selector kinds ---

export type UnitSelector =
  | { readonly kind: 'catalog'; readonly dimensions: readonly DimensionId[] }
  | { readonly kind: 'rate' }
  | { readonly kind: 'effect' }
  | { readonly kind: 'fixed'; readonly symbol: string }

export interface UnitGroup {
  readonly label: string
  readonly symbols: readonly string[]
}

export function unitGroupsFor(spec: { readonly unit: UnitSelector }): readonly UnitGroup[] {
  switch (spec.unit.kind) {
    case 'catalog':
      return spec.unit.dimensions.map((dimension) => ({
        label: dimensionLabel(dimension),
        symbols: unitCatalog.unitsOfDimension(dimension).map((u) => u.symbol),
      }))
    case 'rate':
      return [
        {
          label: 'Per time',
          symbols: unitCatalog.unitsOfDimension('time').map((u) => `1/${u.symbol}`),
        },
      ]
    case 'effect':
    case 'fixed':
      return []
  }
}

// --- Field specification ---

export interface CalculatorFieldSpec {
  readonly key: string
  readonly symbol: string
  readonly label: string
  readonly unit: UnitSelector
  readonly help?: string
  /** True only when the field takes part in the current draft (PK mode). */
  readonly visible?: (draft: CalculatorDraft) => boolean
  /** Explicit-load candidates for this field — never auto-applied. */
  readonly candidates?: (drug: Drug) => readonly LibraryCandidate[]
}

// --- Candidate builders ---

function targetCandidates(
  drug: Drug,
  kind: 'kd' | 'ec50',
  label: string,
): readonly LibraryCandidate[] {
  return drug.targets.flatMap((target) => {
    const value = target[kind]
    if (value === undefined) return []
    return [
      {
        key: `${target.id}:${kind}`,
        label: `${target.name}${target.species !== undefined ? ` (${target.species})` : ''} · ${label}`,
        value: value.value,
        unit: value.unit,
        provenance: value.provenance,
      },
    ]
  })
}

// --- Field specs per model ---

const PK_FIELDS: readonly CalculatorFieldSpec[] = [
  {
    key: 'c0',
    symbol: 'C0',
    label: 'Initial concentration',
    unit: { kind: 'catalog', dimensions: CONCENTRATION_DIMENSIONS },
  },
  {
    key: 'time',
    symbol: 't',
    label: 'Time',
    unit: { kind: 'catalog', dimensions: TIME_DIMENSIONS },
  },
  {
    key: 'halfLife',
    symbol: 't½',
    label: 'Half-life',
    unit: { kind: 'catalog', dimensions: TIME_DIMENSIONS },
    visible: (d) => d.model === 'pk.first-order-one-compartment' && d.mode === 'halfLife',
    candidates: (drug) => {
      const hl = drug.pharmacokinetics.halfLife
      if (hl === undefined) return []
      return [
        {
          key: 'pk:halfLife',
          label: 'Half-life',
          value: hl.value,
          unit: hl.unit,
          provenance: hl.provenance,
        },
      ]
    },
  },
  {
    key: 'k',
    symbol: 'k',
    label: 'Elimination rate constant',
    unit: { kind: 'rate' },
    visible: (d) => d.model === 'pk.first-order-one-compartment' && d.mode === 'k',
  },
]

const OCCUPANCY_FIELDS: readonly CalculatorFieldSpec[] = [
  {
    key: 'concentration',
    symbol: '[D]',
    label: 'Ligand concentration',
    unit: { kind: 'catalog', dimensions: CONCENTRATION_DIMENSIONS },
    help: 'Free equilibrium concentration — supply it explicitly; the calculator never derives it from a dose.',
  },
  {
    key: 'kd',
    symbol: 'Kd',
    label: 'Equilibrium dissociation constant',
    unit: { kind: 'catalog', dimensions: CONCENTRATION_DIMENSIONS },
    candidates: (drug) => targetCandidates(drug, 'kd', 'Kd'),
  },
]

const HILL_FIELDS: readonly CalculatorFieldSpec[] = [
  {
    key: 'concentration',
    symbol: '[D]',
    label: 'Concentration',
    unit: { kind: 'catalog', dimensions: CONCENTRATION_DIMENSIONS },
    help: 'Response-relevant concentration — supply it explicitly.',
  },
  {
    key: 'ec50',
    symbol: 'EC50',
    label: 'Half-maximal concentration',
    unit: { kind: 'catalog', dimensions: CONCENTRATION_DIMENSIONS },
    candidates: (drug) => targetCandidates(drug, 'ec50', 'EC50'),
  },
  {
    key: 'e0',
    symbol: 'E0',
    label: 'Baseline effect',
    unit: { kind: 'effect' },
    help: 'Unit is yours to choose (e.g. "%", "pmol/min") — E0 and Emax must share it.',
  },
  {
    key: 'emax',
    symbol: 'Emax',
    label: 'Maximal effect',
    unit: { kind: 'effect' },
    help: 'Same effect unit as E0.',
  },
  {
    key: 'hillCoefficient',
    symbol: 'n',
    label: 'Hill coefficient',
    unit: { kind: 'fixed', symbol: '1' },
  },
]

export const FIELDS_BY_MODEL: Readonly<Record<ModelId, readonly CalculatorFieldSpec[]>> = {
  'pk.first-order-one-compartment': PK_FIELDS,
  'occupancy.single-site': OCCUPANCY_FIELDS,
  'dose-response.hill': HILL_FIELDS,
}

// --- Engine error parameter → calculator field key ---

const ERROR_FIELD_MAP: Readonly<Record<ModelId, Readonly<Record<string, string>>>> = {
  'pk.first-order-one-compartment': {
    C0: 'c0',
    t: 'time',
    't½': 'halfLife',
    k: 'k',
  },
  'occupancy.single-site': {
    '[D]': 'concentration',
    Kd: 'kd',
  },
  'dose-response.hill': {
    E0: 'e0',
    Emax: 'emax',
    EC50: 'ec50',
    n: 'hillCoefficient',
    '[D]': 'concentration',
  },
}

export function fieldKeyForError(model: ModelId, error: CalculationError): string | undefined {
  const raw = error.parameter
  if (raw === undefined) return undefined
  const symbol = raw.endsWith('.unit') ? raw.slice(0, -5) : raw
  return ERROR_FIELD_MAP[model][symbol]
}

// --- Engine parameter builders ---

function toEngineParameter(draft: ParameterDraft, fixedUnit?: string): EngineParameter {
  const unit = fixedUnit ?? draft.unit.trim()
  return {
    value: Number(draft.value.trim()),
    unit,
    ...(draft.source !== undefined ? { provenance: draft.source.provenance } : {}),
  }
}

function buildPkInput(draft: FirstOrderPKCalculatorInput): FirstOrderPKInput {
  const c0 = toEngineParameter(draft.c0)
  const time = toEngineParameter(draft.time)
  if (draft.mode === 'halfLife') {
    return { c0, time, halfLife: toEngineParameter(draft.halfLife) }
  }
  return { c0, time, k: toEngineParameter(draft.k) }
}

function buildOccupancyInput(draft: ReceptorOccupancyCalculatorInput): ReceptorOccupancyInput {
  return {
    concentration: toEngineParameter(draft.concentration),
    kd: toEngineParameter(draft.kd),
  }
}

function buildHillInput(draft: HillResponseCalculatorInput): HillResponseInput {
  return {
    e0: toEngineParameter(draft.e0),
    emax: toEngineParameter(draft.emax),
    ec50: toEngineParameter(draft.ec50),
    hillCoefficient: toEngineParameter(draft.hillCoefficient, '1'),
    concentration: toEngineParameter(draft.concentration),
  }
}

// --- Calculate dispatch ---

export function calculateDraft(draft: CalculatorDraft): CalculationReport {
  switch (draft.model) {
    case 'pk.first-order-one-compartment':
      return calculateFirstOrderPK(buildPkInput(draft))
    case 'occupancy.single-site':
      return calculateReceptorOccupancy(buildOccupancyInput(draft))
    case 'dose-response.hill':
      return calculateHillResponse(buildHillInput(draft))
  }
}

// --- Curve generation dispatch ---

export function generateCurveForDraft(
  draft: CalculatorDraft,
  options: CurveOptions,
): CurveGenerationResult {
  switch (draft.model) {
    case 'pk.first-order-one-compartment':
      return generatePKCurve(buildPkInput(draft), options)
    case 'occupancy.single-site':
      return generateOccupancyCurve(buildOccupancyInput(draft), options)
    case 'dose-response.hill':
      return generateHillCurve(buildHillInput(draft), options)
  }
}

// --- Empty draft factory ---

function emptyParameter(): ParameterDraft {
  return { value: '', unit: '' }
}

export function emptyDraft(model: ModelId): CalculatorDraft {
  switch (model) {
    case 'pk.first-order-one-compartment':
      // Intentionally include both halfLife and k so switching modes preserves input.
      // The discriminated union type only allows one at a time, but we cast because
      // the runtime value has both and Zod validates only the active branch.
      return {
        model,
        mode: 'halfLife',
        c0: emptyParameter(),
        time: emptyParameter(),
        halfLife: emptyParameter(),
        k: emptyParameter(),
      } as CalculatorDraft
    case 'occupancy.single-site':
      return { model, concentration: emptyParameter(), kd: emptyParameter() }
    case 'dose-response.hill':
      return {
        model,
        e0: emptyParameter(),
        emax: emptyParameter(),
        ec50: emptyParameter(),
        hillCoefficient: emptyParameter(),
        concentration: emptyParameter(),
      }
    default:
      // Exhaustiveness check — TypeScript ensures all ModelId cases handled
      const _exhaustive: never = model
      return _exhaustive
  }
}

// --- Model family grouping for selector ---

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  pk: 'Pharmacokinetics',
  occupancy: 'Pharmacodynamics',
  'dose-response': 'Pharmacodynamics',
}

export interface ModelGroup {
  readonly label: string
  readonly models: readonly (typeof MODELS)[ModelId][]
}

export function modelGroups(): readonly ModelGroup[] {
  const groups = new Map<string, (typeof MODELS)[ModelId][]>()
  for (const model of Object.values(MODELS)) {
    const family = model.id.split('.')[0] ?? ''
    const label = FAMILY_LABELS[family] ?? 'Models'
    const existing = groups.get(label) ?? []
    existing.push(model)
    groups.set(label, existing)
  }
  return Array.from(groups.entries()).map(([label, models]) => ({ label, models }))
}

export function familyLabel(model: ModelId): string {
  return FAMILY_LABELS[model.split('.')[0] ?? ''] ?? 'Models'
}

// --- Type-safe field access helpers ---

/** Get a field from a draft by key, handling the union type safely. */
export function getDraftField(draft: CalculatorDraft, key: string): ParameterDraft | undefined {
  // Use a type assertion through unknown to avoid the index signature overlap error
  // The runtime behavior is correct: we're accessing a known property on the union type
  return (draft as unknown as Record<string, ParameterDraft | undefined>)[key]
}

/** Set a field on a draft, returning a new draft with the updated field. */
export function setDraftField<T extends CalculatorDraft>(draft: T, key: string, patch: Partial<ParameterDraft>): T {
  const field = getDraftField(draft, key)
  if (field === undefined) return draft
  // Clear source by omitting it from the new object (exactOptionalPropertyTypes requires this)
  const { source: _source, ...rest } = field
  const nextField: ParameterDraft = { ...rest, ...patch }
  return { ...draft, [key]: nextField } as T
}

/** Load a library candidate into a draft field. */
export function loadDraftField(draft: CalculatorDraft, key: string, candidate: LibraryCandidate): CalculatorDraft {
  const field = getDraftField(draft, key)
  if (field === undefined) return draft
  const nextField: ParameterDraft = {
    value: String(candidate.value),
    unit: candidate.unit,
    source: { provenance: candidate.provenance, originLabel: candidate.label },
  }
  return { ...draft, [key]: nextField } as CalculatorDraft
}

/** Get all visible field specs for a draft. */
export function getVisibleSpecs(draft: CalculatorDraft): readonly CalculatorFieldSpec[] {
  return FIELDS_BY_MODEL[draft.model].filter((spec) => !spec.visible || spec.visible(draft))
}

/** Get library candidates for a field. */
export function getFieldCandidates(draft: CalculatorDraft, key: string, drug: Drug | undefined): readonly LibraryCandidate[] {
  const spec = FIELDS_BY_MODEL[draft.model].find((s) => s.key === key)
  if (!spec?.candidates || !drug) return []
  return spec.candidates(drug)
}

/** Get the x-axis unit hint for a draft. */
export function getXUnitHint(draft: CalculatorDraft): string {
  if (draft.model === 'pk.first-order-one-compartment') {
    const timeField = getDraftField(draft, 'time')
    return timeField?.unit || 'time unit'
  }
  const concField = getDraftField(draft, 'concentration')
  return concField?.unit || 'concentration unit'
}