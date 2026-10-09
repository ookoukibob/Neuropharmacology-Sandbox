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
  setPKMode as setPKModeHelper,
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

/**
 * Fresh copies of the application-default curve settings (phase 9B).
 *
 * The preferences layer needs its own objects — never the shared
 * `INITIAL_SETTINGS` references — so persisted defaults and live session
 * state can never alias each other. The defaults themselves are defined
 * exactly once, here: the Settings page, preference storage validation and
 * preference reset all reuse them instead of inventing a second set.
 */
export function defaultCalculatorSettings(): Record<ModelId, CurveSettings> {
  return {
    'pk.first-order-one-compartment': defaultSettingsFor('pk.first-order-one-compartment'),
    'occupancy.single-site': defaultSettingsFor('occupancy.single-site'),
    'dose-response.hill': defaultSettingsFor('dose-response.hill'),
  }
}

const INITIAL_SETTINGS: Record<ModelId, CurveSettings> = defaultCalculatorSettings()

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
  curveSettingsStale: boolean
  settings: Record<ModelId, CurveSettings>

  // Actions
  setModel: (model: ModelId) => void
  setDraftField: (key: string, patch: Partial<ParameterDraft>) => void
  setPKMode: (mode: 'halfLife' | 'k') => void
  loadFromLibrary: (key: string, candidate: LibraryCandidate) => void
  setDrugId: (id: string | null) => void
  setRange: (patch: Partial<RangeDraft>) => void
  setXScale: (scale: 'linear' | 'log') => void
  setYScale: (scale: 'linear' | 'log') => void
  applyPresentationSettings: (settings: Record<ModelId, CurveSettings>) => void
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
    curveSettingsStale: false,
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
        curveSettingsStale: false,
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
        curveSettingsStale: report !== null,
      })
    },

    loadFromLibrary: (key, candidate) => {
      const { draft, report } = get()

      const nextDraft = loadDraftField(draft, key, candidate)

      const model = draft.model
      const updatedDrafts = { ...get().draftsByModel, [model]: nextDraft }

      // Mark stale if there's an existing report and the input actually changed
      const stale = report !== null && anyFieldChanged(draft, nextDraft)

      set({
        draft: nextDraft,
        draftsByModel: updatedDrafts,
        stale,
        curveSettingsStale: report !== null,
        // Clear field errors since the user intentionally loaded a valid value from library
        draftErrors: {},
        draftIssues: [],
      })
    },

    setPKMode: (mode) => {
      const { draft, report } = get()
      if (draft.model !== 'pk.first-order-one-compartment') return

      const nextDraft = setPKModeHelper(draft, mode)
      const model = draft.model
      const updatedDrafts = { ...get().draftsByModel, [model]: nextDraft }

      // Changing PK mode fundamentally changes the calculation, so always mark stale if report exists
      const stale = report !== null

      set({
        draft: nextDraft,
        draftsByModel: updatedDrafts,
        stale,
        curveSettingsStale: report !== null,
        // Clear field errors since mode switch is intentional
        draftErrors: {},
        draftIssues: [],
      })
    },

    setDrugId: (id) => {
      set({ drugId: id })
    },

    setRange: (patch) => {
      const { draft, settings, report } = get()
      const current = settings[draft.model]
      set({
        settings: setSettings(get(), draft.model, { ...current, range: { ...current.range, ...patch } }),
        curveSettingsStale: report !== null,
      })
    },

    setXScale: (scale) => {
      const { draft, settings, report } = get()
      const current = settings[draft.model]
      const next = { ...current, xScale: scale }
      // Mark curve settings stale before potentially auto-applying
      const shouldMarkStale = report !== null
      set({ settings: setSettings(get(), draft.model, next), curveSettingsStale: shouldMarkStale })
      // Auto-apply curve on scale change if we have a valid report
      if (get().report?.ok) get().applyCurveSettings()
    },

    setYScale: (scale) => {
      const { draft, settings, report } = get()
      const current = settings[draft.model]
      const next = { ...current, yScale: scale }
      // Mark curve settings stale before potentially auto-applying
      const shouldMarkStale = report !== null
      set({ settings: setSettings(get(), draft.model, next), curveSettingsStale: shouldMarkStale })
      if (get().report?.ok) get().applyCurveSettings()
    },

    applyPresentationSettings: (settings) => {
      // Wholesale update from the preferences layer (startup, the Settings
      // page, preference reset) — persisted curve display defaults only,
      // never a scientific input path: drafts, reports and curve data are
      // deliberately left alone. Like setRange, an existing result's curve
      // is flagged for an explicit re-apply rather than regenerated here:
      // a bulk update mixes range and scale changes, and "Update curve"
      // stays the authority over chart refreshes.
      set({ settings: { ...settings }, curveSettingsStale: get().report !== null })
    },

    applyCurveSettings: () => {
      const { draft, report, settings } = get()
      if (!report?.ok) return

      const s = settings[draft.model]
      const range = s.range

      // Check if range is configured (both min and max provided)
      const hasRange = range.min.trim() !== '' && range.max.trim() !== ''
      if (!hasRange) {
        // Range not configured — clear curve without treating as error
        set({ curve: null, curveErrors: [], curveSettingsStale: false })
        return
      }

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
        set({ curve: null, curveErrors: [...validation.errors], curveSettingsStale: false })
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
        set({ curve: result.curve, curveErrors: [], curveSettingsStale: false })
      } else {
        set({ curve: null, curveErrors: [...result.errors], curveSettingsStale: false })
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
          // Curve is not auto-generated; user must configure range and click "Update curve"
          curve: null,
          curveErrors: [],
          curveSettingsStale: true,
        })
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