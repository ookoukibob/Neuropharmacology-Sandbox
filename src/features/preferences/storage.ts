/**
 * Device-local preference storage (phase 9B): one namespaced
 * `localStorage` record, validated before it is ever written (ADR-19).
 *
 * localStorage, not IndexedDB: preferences are tiny, synchronous-at-
 * startup UI state, and keeping them out of the database keeps the
 * scientific storage schema, record format and migration history
 * untouched. Every access is guarded — a browser that denies storage
 * degrades to in-memory defaults instead of breaking the application.
 *
 * This module owns all raw reads and writes of the preference key;
 * nothing else in the codebase touches it.
 */
import type { ModelId } from '@/engine'
import type { CurveSettings } from '@/features/calculator/store'
import {
  PREFERENCES_STORAGE_KEY,
  toStoredPreferences,
  validatePreferences,
  type StoredPreferences,
  type ThemePreference,
} from './schema'

/**
 * How the last load went:
 * - `ok`          — a valid record was read;
 * - `defaults`    — nothing stored yet (first run, not an error);
 * - `invalid`     — stored data was malformed/unsupported → defaults;
 * - `unavailable` — storage itself threw → in-memory defaults.
 */
export type PreferencesLoadStatus = 'ok' | 'defaults' | 'invalid' | 'unavailable'

export interface PreferencesLoad {
  readonly preferences: StoredPreferences | null
  readonly status: PreferencesLoadStatus
}

/** Read and validate the stored record. Never throws. */
export function loadPreferences(): PreferencesLoad {
  let raw: string | null
  try {
    raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
  } catch {
    return { preferences: null, status: 'unavailable' }
  }
  if (raw === null) return { preferences: null, status: 'defaults' }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { preferences: null, status: 'invalid' }
  }

  const result = validatePreferences(parsed)
  if (!result.ok) return { preferences: null, status: 'invalid' }
  return { preferences: result.preferences, status: 'ok' }
}

/**
 * Validate, then write. Returns false when the candidate does not validate
 * or the browser denies the write — an invalid record is never persisted.
 */
export function savePreferences(
  theme: ThemePreference,
  settings: Record<ModelId, CurveSettings>,
): boolean {
  const record = toStoredPreferences(theme, settings)
  if (record === null) return false
  try {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(record))
    return true
  } catch {
    return false
  }
}
