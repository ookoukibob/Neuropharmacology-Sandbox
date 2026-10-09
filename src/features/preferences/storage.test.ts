/**
 * Preference storage tests (phase 9B): the localStorage round trip and every
 * failure mode — malformed JSON, unsupported versions, invalid values and a
 * browser that denies storage access. The store never throws and never
 * writes a record that failed validation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadPreferences, savePreferences } from './storage'
import { PREFERENCES_STORAGE_KEY, PREFERENCES_VERSION } from './schema'
import { defaultCalculatorSettings } from '@/features/calculator/store'
import type { CurveSettings } from '@/features/calculator/store'
import type { ModelId } from '@/engine'

function modifiedSettings(): Record<ModelId, CurveSettings> {
  const settings = defaultCalculatorSettings()
  return {
    ...settings,
    'occupancy.single-site': {
      range: { min: '0.10', max: '100', points: '250' },
      xScale: 'log',
      yScale: 'linear',
    },
  }
}

function storeRaw(text: string): void {
  window.localStorage.setItem(PREFERENCES_STORAGE_KEY, text)
}

beforeEach(() => {
  window.localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('loadPreferences', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadPreferences()).toEqual({ preferences: null, status: 'defaults' })
  })

  it('round-trips a saved record', () => {
    expect(savePreferences('dark', modifiedSettings())).toBe(true)
    const loaded = loadPreferences()
    expect(loaded.status).toBe('ok')
    expect(loaded.preferences?.theme).toBe('dark')
    expect(loaded.preferences?.calculator.settings['occupancy.single-site'].range).toEqual({
      min: '0.10',
      max: '100',
      points: '250',
    })
  })

  it('preserves string forms verbatim across the round trip', () => {
    expect(savePreferences('light', modifiedSettings())).toBe(true)
    const loaded = loadPreferences()
    expect(loaded.preferences?.calculator.settings['occupancy.single-site'].range.min).toBe(
      '0.10',
    )
  })

  it('reports malformed JSON as invalid', () => {
    storeRaw('{not json')
    expect(loadPreferences()).toEqual({ preferences: null, status: 'invalid' })
  })

  it('reports payloads that are not a preference object as invalid', () => {
    for (const payload of ['null', '42', '"dark"', '["theme"]']) {
      storeRaw(payload)
      expect(loadPreferences(), payload).toEqual({ preferences: null, status: 'invalid' })
    }
  })

  it('reports an unsupported persisted schema version as invalid', () => {
    storeRaw(JSON.stringify({ ...modifiedSettings(), version: PREFERENCES_VERSION + 1 }))
    // Even a theme-only payload with the wrong version is refused wholesale.
    storeRaw(JSON.stringify({ version: 99, theme: 'dark', calculator: { settings: {} } }))
    expect(loadPreferences()).toEqual({ preferences: null, status: 'invalid' })
  })

  it('reports unavailable storage without throwing', () => {
    storeRaw(JSON.stringify({ version: 1, theme: 'dark', calculator: { settings: {} } }))
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    expect(loadPreferences()).toEqual({ preferences: null, status: 'unavailable' })
  })
})

describe('savePreferences', () => {
  it('returns false and writes nothing for an invalid candidate', () => {
    const settings = modifiedSettings()
    settings['occupancy.single-site'] = {
      range: { min: 'abc', max: '100', points: '' },
      xScale: 'linear',
      yScale: 'linear',
    }
    expect(savePreferences('dark', settings)).toBe(false)
    expect(window.localStorage.getItem(PREFERENCES_STORAGE_KEY)).toBeNull()
  })

  it('returns false without throwing when the write is denied', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    expect(savePreferences('dark', modifiedSettings())).toBe(false)
  })
})
