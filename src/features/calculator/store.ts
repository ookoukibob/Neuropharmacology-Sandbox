/**
 * Calculator session store (phase 4): Zustand holds *session state only*.
 *
 * The store manages:
 * - current model
 * - input drafts (per model, so switching models preserves typed values)
 * - validation state (Zod errors)
 * - latest calculation report
 * - latest curve data
 * - curve settings (range, scales) per model
 * - drug context for library-derived parameters
 * - stale flag when inputs change after a calculation
 *
 * IndexedDB is NOT used here — the drug library is the source of truth for
 * persisted data, accessed via the library store. This store is purely
 * transient UI state.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type {
  CalculationReport,
  CalculationError,
  CurveData,
  CurveOptions,
  ModelId,
} from '@/engine'
import {
  validateCurveOptions,
} from '@/engine'
import {
  calculateDraft,
  generateCurveForDraft,
  emptyDraft,
  fieldKeyForError,
  type CalculatorDraft,
  type ParameterDraft,
  type LibraryCandidate,
  getDraftField,
  setDraftField as setDraftFieldHelper,
  loadDraftField,
} from './modelAdapters'
import { validateDraft } from './schemas'
import { MODELS } from '@/engine'

// --- Types ---

export interface RangeDraft {
  readonly min: string
  readonly max: string
  readonly points: string
}

export interface CurveSettings {
  readonly range: RangeDraft
  readonly xScale: 'linear' | 'log'
  readonly yScale: 'linear' | 'log'
}

function defaultSettingsFor(model: ModelId): CurveSettings {
  const isLogX = model !== 'pk.first-order-one-compartment'
  return {
    range: { min: '', max: '', points: '' },
    xScale: isLogX ? 'log' : 'linear',
    yScale: 'linear',
  }
}

const INITIAL_SETTINGS: Record<ModelId, CurveSettings> = {
  'pk.first-order-one-compartment': defaultSettingsFor('pk.first-order-one-compartment'),
  'occupancy.single-site': defaultSettingsFor('occupancy.single-site'),
  'dose-response.hill': defaultSettingsFor('dose-response.hill'),
}

export interface CalculatorState {
  // Model & drafts
  draft: CalculatorDraft
  draftsByModel: Partial<Record<ModelId, CalculatorDraft>>

  // Drug context (for library candidates)
  drugId: string | null

  // Validation (Zod)
  draftErrors: Record<string, string>
  draftIssues: string[]

  // Calculation result
  report: CalculationReport | null
  fieldErrors: Record<string, string>
  globalErrors: string[]
  stale: boolean

  // Curve
  curve: CurveData | null
  curveErrors: CalculationError[]
  settings: Record<ModelId, CurveSettings>

  // Actions
  setModel: (model: ModelId) => void
  setDraftField: (key: string, patch: Partial<ParameterDraft>) => void
  loadFromLibrary: (key: string, candidate: LibraryCandidate) => void
  setDrugId: (id: string | null) => void
  setRange: (patch: Partial<RangeDraft>) => void
  setXScale: (scale: 'linear' | 'log') => void
  setYScale: (scale: 'linear' | 'log') => void
  applyCurveSettings: () => void
  calculate: () => void
  resetInputs: () => void
  applyUrlParams: (params: { model?: string | null; drug?: string | null }) => void
}

function anyFieldChanged(oldDraft: CalculatorDraft, newDraft: CalculatorDraft): boolean {
  const keys = Object.keys(newDraft).filter((k) => k !== 'model' && k !== 'mode')
  for (const key of keys) {
    const oldVal = getDraftField(oldDraft, key)
    const newVal = getDraftField(newDraft, key)
    if (oldVal === undefined || newVal === undefined) continue
    if (oldVal.value !== newVal.value || oldVal.unit !== newVal.unit) return true
  }
  return false
}

function setSettings(state: CalculatorState, model: ModelId, next: CurveSettings): Record<ModelId, CurveSettings> {
  return { ...state.settings, [model]: next }
}

export function createCalculatorStore(): UseBoundStore<StoreApi<CalculatorState>> {
  return create<CalculatorState>()((set, get) => ({
    // Initial state
    draft: emptyDraft('occupancy.single-site'),
    draftsByModel: {},
    drugId: null,
    draftErrors: {},
    draftIssues: [],
    report: null,
    fieldErrors: {},
    globalErrors: [],
    stale: false,
    curve: null,
    curveErrors: [],
    settings: INITIAL_SETTINGS,

    // Actions
    setModel: (model) => {
      const currentModel = get().draft.model
      if (model === currentModel) return

      // Preserve current model's draft
      const { draft, draftsByModel } = get()
      const updatedDrafts = { ...draftsByModel, [currentModel]: draft }

      // Restore or create new draft for the target model
      const nextDraft = updatedDrafts[model] ?? emptyDraft(model)

      set({
        draft: nextDraft,
        draftsByModel: updatedDrafts,
        report: null,
        fieldErrors: {},
        globalErrors: [],
        stale: false,
        curve: null,
        curveErrors: [],
      })
    },

    setDraftField: (key, patch) => {
      const { draft, report } = get()

      // Only allow editing fields that exist in the current draft
      const field = getDraftField(draft, key)
      if (field === undefined) return

      const nextDraft = setDraftFieldHelper(draft, key, patch)

      // Update per-model draft store
      const model = draft.model
      const updatedDrafts = { ...get().draftsByModel, [model]: nextDraft }

      // Mark stale if we already had a result and the value actually changed
      const stale = report !== null && anyFieldChanged(draft, nextDraft)

      set({
        draft: nextDraft,
        draftsByModel: updatedDrafts,
        draftErrors: {}, // clear Zod errors on edit
        draftIssues: [],
        stale,
      })
    },

    loadFromLibrary: (key, candidate) => {
      const { draft } = get()

      const nextDraft = loadDraftField(draft, key, candidate)

      const model = draft.model
      const updatedDrafts = { ...get().draftsByModel, [model]: nextDraft }

      set({
        draft: nextDraft,
        draftsByModel: updatedDrafts,
        stale: false, // loading from library is an intentional input change, not "stale"
      })
    },

    setDrugId: (id) => {
      set({ drugId: id })
    },

    setRange: (patch) => {
      const { draft, settings } = get()
      const current = settings[draft.model]
      set({
        settings: setSettings(get(), draft.model, { ...current, range: { ...current.range, ...patch } }),
      })
    },

    setXScale: (scale) => {
      const { draft, settings } = get()
      const current = settings[draft.model]
      const next = { ...current, xScale: scale }
      set({ settings: setSettings(get(), draft.model, next) })
      // Auto-apply curve on scale change if we have a valid report
      if (get().report?.ok) get().applyCurveSettings()
    },

    setYScale: (scale) => {
      const { draft, settings } = get()
      const current = settings[draft.model]
      const next = { ...current, yScale: scale }
      set({ settings: setSettings(get(), draft.model, next) })
      if (get().report?.ok) get().applyCurveSettings()
    },

    applyCurveSettings: () => {
      const { draft, report, settings } = get()
      if (!report?.ok) return

      const s = settings[draft.model]
      const range = s.range
      const toFinite = (str: string): number => {
        const trimmed = str.trim()
        return trimmed === '' ? Number.NaN : Number(trimmed)
      }
      const points = range.points.trim() === '' ? undefined : Number(range.points.trim())

      const options: CurveOptions = {
        range: { min: toFinite(range.min), max: toFinite(range.max), points: points as number },
        xScale: s.xScale,
        yScale: s.yScale,
      }

      const validation = validateCurveOptions(options, s.xScale)
      if (!validation.ok) {
        set({ curve: null, curveErrors: [...validation.errors] })
        return
      }

      // Convert ValidatedCurveOptions to CurveOptions for the generator
      const curveOptions: CurveOptions = {
        range: { min: validation.options.min, max: validation.options.max, points: validation.options.count },
        xScale: validation.options.xScale,
        yScale: validation.options.yScale,
      }

      const result = generateCurveForDraft(draft, curveOptions)
      if (result.ok) {
        set({ curve: result.curve, curveErrors: [] })
      } else {
        set({ curve: null, curveErrors: [...result.errors] })
      }
    },

    calculate: () => {
      const { draft } = get()

      // Zod validation first
      const validation = validateDraft(draft)
      if (Object.keys(validation.fields).length > 0 || validation.issues.length > 0) {
        set({
          draftErrors: validation.fields,
          draftIssues: [...validation.issues],
          report: null,
          fieldErrors: {},
          globalErrors: [],
          stale: false,
          curve: null,
          curveErrors: [],
        })
        return
      }

      // Clear Zod errors, run engine
      set({ draftErrors: {}, draftIssues: [] })

      const report = calculateDraft(draft)

      if (report.ok) {
        set({
          report,
          fieldErrors: {},
          globalErrors: [],
          stale: false,
        })
        // Auto-generate curve with current settings
        get().applyCurveSettings()
      } else {
        // Map engine errors to fields
        const fieldErrors: Record<string, string> = {}
        const globalErrors: string[] = []
        for (const error of report.errors) {
          const key = fieldKeyForError(report.model, error)
          if (key !== undefined && fieldErrors[key] === undefined) {
            fieldErrors[key] = error.message
          } else if (key === undefined) {
            globalErrors.push(error.message)
          }
        }
        set({
          report,
          fieldErrors,
          globalErrors,
          stale: false,
          curve: null,
          curveErrors: [],
        })
      }
    },

    resetInputs: () => {
      const { draft } = get()
      const model = draft.model
      const nextDraft = emptyDraft(model)
      const updatedDrafts = { ...get().draftsByModel, [model]: nextDraft }
      set({
        draft: nextDraft,
        draftsByModel: updatedDrafts,
        draftErrors: {},
        draftIssues: [],
        report: null,
        fieldErrors: {},
        globalErrors: [],
        stale: false,
        curve: null,
        curveErrors: [],
      })
    },

    applyUrlParams: (params) => {
      const { draft, drugId } = get()
      const patch: Partial<CalculatorState> = {}

      if (params.model !== null && params.model !== undefined) {
        const model = params.model as ModelId
        if (MODELS[model] && model !== draft.model) {
          patch.draft = get().draftsByModel[model] ?? emptyDraft(model)
          patch.draftsByModel = { ...get().draftsByModel, [draft.model]: draft }
          patch.report = null
          patch.fieldErrors = {}
          patch.globalErrors = []
          patch.stale = false
          patch.curve = null
          patch.curveErrors = []
        }
      }

      if (params.drug !== null && params.drug !== undefined && params.drug !== drugId) {
        patch.drugId = params.drug
      }

      if (Object.keys(patch).length > 0) set(patch)
    },
  }))
}

export type CalculatorStore = ReturnType<typeof createCalculatorStore>