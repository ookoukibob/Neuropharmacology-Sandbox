/**
 * Preferences store tests (phase 9B): one authoritative state with one
 * write path — defaults, round trip, theme application (including live
 * system-mode changes), the calculator push, reset scope and a browser
 * that denies storage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPreferencesStore } from './store'
import { PREFERENCES_STORAGE_KEY, PREFERENCES_VERSION } from './schema'
import { defaultCalculatorSettings } from '@/features/calculator/store'
import type { CurveSettings } from '@/features/calculator/store'

function newStore() {
  const applyCalculatorSettings = vi.fn()
  const store = createPreferencesStore({ applyCalculatorSettings })
  return { store, applyCalculatorSettings }
}

function storedRaw(): string | null {
  return window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
}

function seedStored(raw: Record<string, unknown>): void {
  window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(raw))
}

function storedRecord(): Record<string, unknown> {
  const raw = storedRaw()
  if (raw === null) throw new Error('expected a stored record')
  return JSON.parse(raw) as Record<string, unknown>
}

/** Minimal matchMedia stub: controllable `matches` plus change listeners. */
function stubMatchMedia(initialMatches: boolean): {
  readonly setMatches: (value: boolean) => void
  readonly listenerCount: () => number
} {
  const listeners = new Set<() => void>()
  const mediaQueryList = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_type: string, listener: () => void) => {
      listeners.add(listener)
    },
    removeEventListener: (_type: string, listener: () => void) => {
      listeners.delete(listener)
    },
  }
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (_query: string) => mediaQueryList,
  })
  return {
    setMatches: (value: boolean) => {
      mediaQueryList.matches = value
      for (const listener of listeners) listener()
    },
    listenerCount: () => listeners.size,
  }
}

function htmlIsDark(): boolean {
  return document.documentElement.classList.contains('dark')
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.classList.remove('dark')
})

afterEach(() => {
  vi.restoreAllMocks()
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('createPreferencesStore — defaults and initialization', () => {
  it('starts with the documented defaults', () => {
    const { store } = newStore()
    expect(store.getState().theme).toBe('system')
    expect(store.getState().loadStatus).toBe('defaults')
    expect(store.getState().calculatorSettings).toEqual(defaultCalculatorSettings())
  })

  it('initialize applies a stored record: theme class, settings and the calculator push', () => {
    const settings = defaultCalculatorSettings()
    settings['occupancy.single-site'] = {
      range: { min: '0.10', max: '100', points: '250' },
      xScale: 'linear',
      yScale: 'linear',
    }
    seedStored({ version: 1, theme: 'dark', calculator: { settings } })

    const { store, applyCalculatorSettings } = newStore()
    store.getState().initialize()

    expect(store.getState().theme).toBe('dark')
    expect(store.getState().loadStatus).toBe('ok')
    expect(htmlIsDark()).toBe(true)
    expect(applyCalculatorSettings).toHaveBeenCalledWith(
      store.getState().calculatorSettings,
    )
    expect(
      store.getState().calculatorSettings['occupancy.single-site'].range.min,
    ).toBe('0.10')
  })

  it('initialize with nothing stored resolves system mode against the OS and leaves the calculator alone', () => {
    stubMatchMedia(true) // OS says dark
    const { store, applyCalculatorSettings } = newStore()
    store.getState().initialize()

    expect(store.getState().theme).toBe('system')
    expect(store.getState().loadStatus).toBe('defaults')
    expect(htmlIsDark()).toBe(true)
    expect(applyCalculatorSettings).not.toHaveBeenCalled()
  })

  it('initialize rejects malformed stored data and falls back to defaults', () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, '{broken')
    const { store, applyCalculatorSettings } = newStore()
    store.getState().initialize()

    expect(store.getState().loadStatus).toBe('invalid')
    expect(store.getState().theme).toBe('system')
    expect(store.getState().calculatorSettings).toEqual(defaultCalculatorSettings())
    expect(htmlIsDark()).toBe(false)
    expect(applyCalculatorSettings).not.toHaveBeenCalled()
  })

  it('initialize reports unavailable storage without throwing', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    const { store } = newStore()
    expect(() => store.getState().initialize()).not.toThrow()
    expect(store.getState().loadStatus).toBe('unavailable')
    expect(store.getState().theme).toBe('system')
  })
})

describe('createPreferencesStore — theme behavior', () => {
  it('setTheme applies the class immediately and persists the record', () => {
    const { store } = newStore()
    store.getState().setTheme('dark')
    expect(htmlIsDark()).toBe(true)
    expect(storedRecord()['theme']).toBe('dark')

    store.getState().setTheme('light')
    expect(htmlIsDark()).toBe(false)
    expect(storedRecord()['theme']).toBe('light')
  })

  it('system mode follows OS changes while active', () => {
    const media = stubMatchMedia(false)
    const { store } = newStore()
    store.getState().setTheme('system')
    expect(htmlIsDark()).toBe(false)

    media.setMatches(true)
    expect(htmlIsDark()).toBe(true)
    media.setMatches(false)
    expect(htmlIsDark()).toBe(false)
  })

  it('manual themes are not overridden by later OS changes', () => {
    const media = stubMatchMedia(false)
    const { store } = newStore()
    store.getState().setTheme('dark')

    media.setMatches(true)
    media.setMatches(false)
    expect(htmlIsDark()).toBe(true)
    expect(media.listenerCount()).toBe(0) // the system listener is unbound
  })

  it('switching back to system re-binds the OS listener', () => {
    const media = stubMatchMedia(true)
    const { store } = newStore()
    store.getState().setTheme('light')
    store.getState().setTheme('system')

    expect(htmlIsDark()).toBe(true) // resolves against the current OS
    media.setMatches(false)
    expect(htmlIsDark()).toBe(false)
  })
})

describe('createPreferencesStore — calculator display defaults', () => {
  it('setCalculatorSettings persists only the edited model and pushes the merged set', () => {
    const { store, applyCalculatorSettings } = newStore()
    const next: CurveSettings = {
      range: { min: '0.10', max: '100', points: '' },
      xScale: 'log',
      yScale: 'linear',
    }
    store.getState().setCalculatorSettings('occupancy.single-site', next)

    expect(applyCalculatorSettings).toHaveBeenCalledWith(store.getState().calculatorSettings)
    const record = storedRecord()
    const settings = (record['calculator'] as { settings: Record<string, unknown> }).settings
    expect(settings['occupancy.single-site']).toEqual(next)
    expect(settings['pk.first-order-one-compartment']).toEqual(
      defaultCalculatorSettings()['pk.first-order-one-compartment'],
    )
  })

  it('refuses an invalid candidate: state, storage and the calculator stay untouched', () => {
    const { store, applyCalculatorSettings } = newStore()
    store.getState().setTheme('light')
    applyCalculatorSettings.mockClear()
    const before = storedRaw()

    store.getState().setCalculatorSettings('occupancy.single-site', {
      range: { min: 'abc', max: '100', points: '' },
      xScale: 'linear',
      yScale: 'linear',
    })

    expect(
      store.getState().calculatorSettings['occupancy.single-site'],
    ).toEqual(defaultCalculatorSettings()['occupancy.single-site'])
    expect(storedRaw()).toBe(before)
    expect(applyCalculatorSettings).not.toHaveBeenCalled()
  })

  it('resetCalculatorSettings restores the defaults without touching the theme', () => {
    const { store } = newStore()
    store.getState().setTheme('dark')
    store.getState().setCalculatorSettings('occupancy.single-site', {
      range: { min: '5', max: '10', points: '' },
      xScale: 'linear',
      yScale: 'linear',
    })

    store.getState().resetCalculatorSettings()

    expect(store.getState().calculatorSettings).toEqual(defaultCalculatorSettings())
    expect(store.getState().theme).toBe('dark')
    const record = storedRecord()
    expect(record['theme']).toBe('dark')
    expect(htmlIsDark()).toBe(true)
  })

  it('resetPreferences restores theme and calculator defaults and persists them', () => {
    const { store, applyCalculatorSettings } = newStore()
    store.getState().setTheme('dark')
    store.getState().setCalculatorSettings('pk.first-order-one-compartment', {
      range: { min: '1', max: '2', points: '' },
      xScale: 'linear',
      yScale: 'linear',
    })
    applyCalculatorSettings.mockClear()

    store.getState().resetPreferences()

    expect(store.getState().theme).toBe('system')
    expect(store.getState().calculatorSettings).toEqual(defaultCalculatorSettings())
    expect(htmlIsDark()).toBe(false)
    expect(applyCalculatorSettings).toHaveBeenCalledWith(defaultCalculatorSettings())
    const record = storedRecord()
    expect(record['theme']).toBe('system')
    expect(record['version']).toBe(PREFERENCES_VERSION)
  })

  it('a failed write flips the status but keeps the live change', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota exceeded')
    })
    const { store } = newStore()
    store.getState().setTheme('dark')

    expect(store.getState().theme).toBe('dark')
    expect(htmlIsDark()).toBe(true)
    expect(store.getState().loadStatus).toBe('unavailable')
  })

  it('persisted records contain only preference keys — never scientific state', () => {
    const { store } = newStore()
    store.getState().setTheme('dark')
    store.getState().setCalculatorSettings('dose-response.hill', {
      range: { min: '0', max: '100', points: '' },
      xScale: 'linear',
      yScale: 'linear',
    })

    const record = storedRecord()
    expect(Object.keys(record).sort()).toEqual(['calculator', 'theme', 'version'])
    expect(Object.keys(record['calculator'] as object)).toEqual(['settings'])
  })
})
