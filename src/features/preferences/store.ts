/**
 * Application preferences store (phase 9B): the single authoritative state
 * for persisted presentation preferences — the appearance theme plus the
 * calculator's per-model curve display defaults.
 *
 * Design rules (ADR-19):
 * - one state, one write path: every mutation goes validate → persist →
 *   apply (theme class, live calculator settings), never raw storage;
 * - the store owns presentation preferences only — no drafts, no reports,
 *   no curve data, no drug records — so a preference write can never
 *   touch scientific state;
 * - a candidate that fails validation is refused outright (state and
 *   storage stay untouched); the Settings UI surfaces the field message;
 * - `initialize()` runs once at startup from `main.tsx` before the first
 *   render; tests may call it again to re-read storage.
 *
 * The calculator push (`applyCalculatorSettings`) is injected by the
 * composition root so this feature never imports the app layer.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ModelId } from '@/engine'
import {
  defaultCalculatorSettings,
  type CurveSettings,
} from '@/features/calculator/store'
import { toStoredPreferences, type ThemePreference } from './schema'
import {
  loadPreferences,
  savePreferences,
  type PreferencesLoadStatus,
} from './storage'
import { applyThemePreference } from './theme'

export interface PreferencesDeps {
  /** Push saved/default curve display defaults into the live calculator store. */
  readonly applyCalculatorSettings: (settings: Record<ModelId, CurveSettings>) => void
}

export interface PreferencesState {
  readonly theme: ThemePreference
  /** Persisted calculator display defaults; always complete (every model). */
  readonly calculatorSettings: Record<ModelId, CurveSettings>
  readonly loadStatus: PreferencesLoadStatus
  /** Load stored preferences and apply them (theme class + calculator). */
  initialize: () => void
  setTheme: (theme: ThemePreference) => void
  setCalculatorSettings: (model: ModelId, settings: CurveSettings) => void
  /** Restore only the calculator display defaults (theme untouched). */
  resetCalculatorSettings: () => void
  /** Restore theme + calculator display defaults (scientific data untouched). */
  resetPreferences: () => void
}

export function createPreferencesStore(
  dependencies: PreferencesDeps,
): UseBoundStore<StoreApi<PreferencesState>> {
  return create<PreferencesState>()((set, get) => {
    /** Persist current state; a failed write flips the visible status. */
    const persist = (): void => {
      const { theme, calculatorSettings } = get()
      if (!savePreferences(theme, calculatorSettings)) {
        set({ loadStatus: 'unavailable' })
      }
    }

    return {
      theme: 'system',
      calculatorSettings: defaultCalculatorSettings(),
      loadStatus: 'defaults',

      initialize: () => {
        const { preferences, status } = loadPreferences()
        const theme = preferences?.theme ?? 'system'
        const calculatorSettings =
          preferences?.calculator.settings ?? defaultCalculatorSettings()
        set({ theme, calculatorSettings, loadStatus: status })
        applyThemePreference(theme)
        if (preferences !== null) {
          // Nothing stored means the calculator is already at the same
          // defaults, so only stored settings are pushed.
          dependencies.applyCalculatorSettings(calculatorSettings)
        }
      },

      setTheme: (theme) => {
        set({ theme })
        applyThemePreference(theme)
        persist()
      },

      setCalculatorSettings: (model, settings) => {
        const candidate = toStoredPreferences(get().theme, {
          ...get().calculatorSettings,
          [model]: settings,
        })
        // Authority check: the UI validates for messages, the store
        // refuses anything that would not survive a reload.
        if (candidate === null) return
        const calculatorSettings = candidate.calculator.settings
        set({ calculatorSettings })
        dependencies.applyCalculatorSettings(calculatorSettings)
        persist()
      },

      resetCalculatorSettings: () => {
        const calculatorSettings = defaultCalculatorSettings()
        set({ calculatorSettings })
        dependencies.applyCalculatorSettings(calculatorSettings)
        persist()
      },

      resetPreferences: () => {
        const calculatorSettings = defaultCalculatorSettings()
        set({ theme: 'system', calculatorSettings, loadStatus: 'ok' })
        applyThemePreference('system')
        dependencies.applyCalculatorSettings(calculatorSettings)
        persist()
      },
    }
  })
}
