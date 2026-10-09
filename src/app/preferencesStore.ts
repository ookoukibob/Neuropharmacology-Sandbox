/**
 * Composition root for application preferences (phase 9B): the preferences
 * feature wired to the live calculator session store, mirroring
 * `calculatorStore.ts`. Components import `usePreferencesStore` from here;
 * tests create their own store with `createPreferencesStore`.
 *
 * This is the only module that connects the two stores: the preferences
 * store owns what is *persisted* (theme + per-model curve display
 * defaults), and saved defaults are pushed into the calculator's session
 * state at startup and whenever they change on the Settings page.
 */
import { createPreferencesStore } from '@/features/preferences'
import { useCalculatorStore } from './calculatorStore'

export const usePreferencesStore = createPreferencesStore({
  applyCalculatorSettings: (settings) => {
    useCalculatorStore.getState().applyPresentationSettings(settings)
  },
})

/**
 * Load stored preferences and apply them: the theme class lands on the
 * document root and saved curve display defaults are pushed into the
 * calculator store. Called once from `main.tsx`, synchronously before
 * the first render, so the app paints with the chosen theme.
 */
export function initializePreferences(): void {
  usePreferencesStore.getState().initialize()
}
