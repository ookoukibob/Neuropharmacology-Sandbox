/**
 * Settings page tests (phase 9B): the controls are wired to the real app
 * stores — theme applied to the document root, calculator display defaults
 * persisted per model, invalid text refused with a field message, links to
 * the existing Import / Export page, and a scoped, acknowledged reset that
 * never touches scientific state.
 */
import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsPage } from './SettingsPage'
import { initializePreferences, usePreferencesStore } from '@/app/preferencesStore'
import { useCalculatorStore } from '@/app/calculatorStore'
import { libraryRepository } from '@/app/libraryStore'
import { getDraftField } from '@/features/calculator/modelAdapters'
import { defaultCalculatorSettings } from '@/features/calculator/store'
import { PREFERENCES_STORAGE_KEY } from '@/features/preferences'

function renderSettings() {
  return render(
    <MemoryRouter>
      <SettingsPage />
    </MemoryRouter>,
  )
}

function storedRecord(): Record<string, unknown> | null {
  const raw = window.localStorage.getItem(PREFERENCES_STORAGE_KEY)
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>)
}

function storedSettings(): Record<string, Record<string, unknown>> | null {
  const record = storedRecord()
  if (record === null) return null
  const calculator = record['calculator'] as { settings: Record<string, Record<string, unknown>> }
  return calculator.settings
}

function occupancyMinInput(): HTMLInputElement {
  return screen.getByTestId('pref-range-min-occupancy.single-site')
}

beforeEach(() => {
  window.localStorage.clear()
  document.documentElement.classList.remove('dark')
  usePreferencesStore.setState({
    theme: 'system',
    calculatorSettings: defaultCalculatorSettings(),
    loadStatus: 'defaults',
  })
  useCalculatorStore.setState({ settings: defaultCalculatorSettings() })
  initializePreferences()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('SettingsPage — sections and appearance', () => {
  it('renders all four sections with accessible headings and theme options', () => {
    renderSettings()

    for (const heading of [
      'Appearance',
      'Calculator display defaults',
      'Data management and recovery',
      'About and scientific scope',
    ]) {
      expect(
        screen.getByRole('heading', { level: 2, name: heading }),
      ).toBeInTheDocument()
    }
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'Light' })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Dark' })).toBeInTheDocument()
  })

  it('applies a theme change immediately and persists it', () => {
    renderSettings()

    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(storedRecord()?.['theme']).toBe('dark')

    fireEvent.click(screen.getByRole('radio', { name: 'Light' }))
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(storedRecord()?.['theme']).toBe('light')
  })

  it('surfaces the invalid-preferences note when stored data could not be read', () => {
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, '{broken')
    initializePreferences()
    renderSettings()

    expect(screen.getByTestId('preferences-invalid-note')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'System' })).toBeChecked()
  })

  it('surfaces unavailable storage and still applies changes for the session', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('storage denied')
    })
    initializePreferences()
    renderSettings()

    expect(screen.getByTestId('preferences-unavailable-note')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    expect(document.documentElement.classList.contains('dark')).toBe(true)
  })
})

describe('SettingsPage — calculator display defaults', () => {
  it('renders one block per model with the current defaults and persists a valid change', () => {
    renderSettings()

    for (const testId of [
      'settings-model-pk.first-order-one-compartment',
      'settings-model-occupancy.single-site',
      'settings-model-dose-response.hill',
    ]) {
      expect(screen.getByTestId(testId)).toBeInTheDocument()
    }
    expect(occupancyMinInput()).toHaveValue('')

    fireEvent.change(occupancyMinInput(), { target: { value: '5' } })

    expect(occupancyMinInput()).toHaveValue('5')
    const settings = storedSettings()
    expect(settings?.['occupancy.single-site']?.['range']).toEqual({
      min: '5',
      max: '',
      points: '',
    })
    // Other models keep their own (independent) defaults.
    expect(settings?.['pk.first-order-one-compartment']?.['range']).toEqual({
      min: '',
      max: '',
      points: '',
    })
  })

  it('refuses invalid range text with a field message and never saves it', () => {
    renderSettings()

    fireEvent.change(occupancyMinInput(), { target: { value: 'abc' } })

    expect(occupancyMinInput()).toHaveAttribute('aria-invalid', 'true')
    expect(occupancyMinInput()).toHaveAccessibleDescription(/finite number/)
    expect(
      usePreferencesStore.getState().calculatorSettings['occupancy.single-site'].range.min,
    ).toBe('')
    expect(storedSettings()).toBeNull()
  })

  it('enforces the engine cross-field range rules on a fully entered range', () => {
    renderSettings()

    fireEvent.change(occupancyMinInput(), { target: { value: '10' } })
    fireEvent.change(screen.getByTestId('pref-range-max-occupancy.single-site'), {
      target: { value: '5' },
    })

    expect(screen.getByText(/must be less than/)).toBeInTheDocument()
    const settings = storedSettings()
    expect(settings?.['occupancy.single-site']?.['range']).toEqual({
      min: '10',
      max: '',
      points: '',
    })
  })

  it('restore button restores calculator defaults but keeps the theme', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    fireEvent.change(occupancyMinInput(), { target: { value: '5' } })

    fireEvent.click(screen.getByTestId('restore-calculator-defaults'))

    expect(occupancyMinInput()).toHaveValue('')
    expect(screen.getByTestId('calculator-defaults-restored')).toBeInTheDocument()
    expect(storedRecord()?.['theme']).toBe('dark')
    expect(
      usePreferencesStore.getState().calculatorSettings['occupancy.single-site'],
    ).toEqual(defaultCalculatorSettings()['occupancy.single-site'])
  })
})

describe('SettingsPage — data management, about and reset', () => {
  it('links to the existing Import / Export page', () => {
    renderSettings()

    const link = screen.getByRole('link', { name: 'Open Import / Export' })
    expect(link).toHaveAttribute('href', '/import-export')
  })

  it('shows verified metadata and the repository link in About', () => {
    renderSettings()

    expect(screen.getByTestId('about-version')).toHaveTextContent(
      'Version 0.0.0 · License PolyForm-Noncommercial-1.0.0',
    )
    expect(screen.getByTestId('about-repository-link')).toHaveAttribute(
      'href',
      'https://github.com/ookoukibob/Neuropharmacology-Sandbox',
    )
  })

  it('reset needs acknowledgement, then restores defaults in state and storage', () => {
    renderSettings()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    fireEvent.change(occupancyMinInput(), { target: { value: '5' } })

    fireEvent.click(screen.getByTestId('settings-reset'))
    expect(screen.getByTestId('settings-reset-confirm')).toBeInTheDocument()
    expect(screen.getByTestId('settings-reset-confirm')).toHaveFocus()
    expect(screen.getByTestId('settings-reset-confirm')).toHaveAccessibleDescription(
      /Reset the appearance theme/,
    )

    // Escape cancels without resetting.
    fireEvent.keyDown(screen.getByTestId('settings-reset-confirm'), { key: 'Escape' })
    expect(screen.queryByTestId('settings-reset-confirm')).not.toBeInTheDocument()
    expect(storedRecord()?.['theme']).toBe('dark')

    // Confirming restores both slices and persists them.
    fireEvent.click(screen.getByTestId('settings-reset'))
    fireEvent.click(screen.getByTestId('settings-reset-confirm'))

    expect(screen.getByTestId('theme-system')).toBeChecked()
    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(occupancyMinInput()).toHaveValue('')
    expect(screen.getByTestId('preferences-reset-done')).toBeInTheDocument()
    const record = storedRecord()
    expect(record?.['theme']).toBe('system')
    expect(screen.getByTestId('settings-reset')).toBeInTheDocument()
  })

  it('reset never touches scientific data or calculator drafts', () => {
    // A scientific draft in the calculator session store.
    useCalculatorStore.getState().setDraftField('kd', { value: '4.2', unit: 'nM' })

    const mutators = [
      'createDrug',
      'updateDrug',
      'deleteDrug',
      'replaceLibrary',
      'importLibrary',
      'restoreRecoveryArchive',
    ] as const
    const spies = mutators.map((method) => vi.spyOn(libraryRepository, method))

    renderSettings()
    fireEvent.click(screen.getByRole('radio', { name: 'Dark' }))
    fireEvent.click(screen.getByTestId('settings-reset'))
    fireEvent.click(screen.getByTestId('settings-reset-confirm'))

    for (const spy of spies) {
      expect(spy).not.toHaveBeenCalled()
    }
    const draft = useCalculatorStore.getState().draft
    expect(getDraftField(draft, 'kd')?.value).toBe('4.2')
    expect(JSON.stringify(storedRecord())).not.toContain('4.2')
  })
})
