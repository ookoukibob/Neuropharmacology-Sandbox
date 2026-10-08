/**
 * Unit tests for calculator store (phase 4).
 *
 * Tests state transitions, stale tracking, PK mode switching,
 * library loading, and curve settings management.
 * Uses the store factory directly for isolation.
 */
import { describe, expect, it } from 'vitest'
import { createCalculatorStore } from './store'
import { getDraftField } from './modelAdapters'
import type {
  CalculatorDraft,
  FirstOrderPKCalculatorInput,
  HillResponseCalculatorInput,
  ParameterDraft,
  ReceptorOccupancyCalculatorInput,
} from './schemas'

function setupStore() {
  return createCalculatorStore()
}

// --- Discriminated-union narrowing helpers ---
// `draft` is a CalculatorDraft union; narrow it with a runtime check that
// throws instead of casting, so field access stays type-safe.

type PKHalfLifeDraft = Extract<FirstOrderPKCalculatorInput, { mode: 'halfLife' }>
type PKKDraft = Extract<FirstOrderPKCalculatorInput, { mode: 'k' }>

function occupancyDraftOf(draft: CalculatorDraft): ReceptorOccupancyCalculatorInput {
  if (draft.model !== 'occupancy.single-site') {
    throw new Error(`expected occupancy draft, received ${draft.model}`)
  }
  return draft
}

function hillDraftOf(draft: CalculatorDraft): HillResponseCalculatorInput {
  if (draft.model !== 'dose-response.hill') {
    throw new Error(`expected hill draft, received ${draft.model}`)
  }
  return draft
}

function pkDraftOf(draft: CalculatorDraft): FirstOrderPKCalculatorInput {
  if (draft.model !== 'pk.first-order-one-compartment') {
    throw new Error(`expected PK draft, received ${draft.model}`)
  }
  return draft
}

function pkKDraftOf(draft: CalculatorDraft): PKKDraft {
  const pk = pkDraftOf(draft)
  if (pk.mode !== 'k') throw new Error(`expected PK mode 'k', received ${pk.mode}`)
  return pk
}

function pkHalfLifeDraftOf(draft: CalculatorDraft): PKHalfLifeDraft {
  const pk = pkDraftOf(draft)
  if (pk.mode !== 'halfLife') throw new Error(`expected PK mode 'halfLife', received ${pk.mode}`)
  return pk
}

describe('calculator store', () => {
  describe('initial state', () => {
    it('starts with occupancy model', () => {
      const store = setupStore()
      expect(store.getState().draft.model).toBe('occupancy.single-site')
      expect(store.getState().stale).toBe(false)
      expect(store.getState().report).toBeNull()
      expect(store.getState().curve).toBeNull()
    })

    it('starts with empty draftsByModel', () => {
      const store = setupStore()
      expect(store.getState().draftsByModel).toEqual({})
    })

    it('starts with default curve settings per model', () => {
      const store = setupStore()
      const settings = store.getState().settings
      expect(settings['pk.first-order-one-compartment'].xScale).toBe('linear')
      expect(settings['occupancy.single-site'].xScale).toBe('log')
      expect(settings['dose-response.hill'].xScale).toBe('log')
    })
  })

  describe('setModel', () => {
    it('switches model and preserves previous draft', () => {
      const store = setupStore()

      // Fill occupancy draft
      store.getState().setDraftField('concentration', { value: '10', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '5', unit: 'nM' })

      // Switch to PK
      store.getState().setModel('pk.first-order-one-compartment')
      expect(store.getState().draft.model).toBe('pk.first-order-one-compartment')
      expect(store.getState().draftsByModel['occupancy.single-site']).toBeDefined()

      // Switch back to occupancy - draft should be preserved
      store.getState().setModel('occupancy.single-site')
      expect(store.getState().draft.model).toBe('occupancy.single-site')
      const occDraft = occupancyDraftOf(store.getState().draft)
      expect(occDraft.concentration.value).toBe('10')
      expect(occDraft.kd.value).toBe('5')
    })

    it('clears results when switching model', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      expect(store.getState().report).not.toBeNull()

      store.getState().setModel('pk.first-order-one-compartment')
      expect(store.getState().report).toBeNull()
      expect(store.getState().stale).toBe(false)
    })

    it('initializes new model with empty draft if not seen before', () => {
      const store = setupStore()
      store.getState().setModel('dose-response.hill')
      expect(store.getState().draft.model).toBe('dose-response.hill')
      expect(hillDraftOf(store.getState().draft).e0.value).toBe('')
    })
  })

  describe('setDraftField', () => {
    it('updates field value', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '15.0' })
      expect(occupancyDraftOf(store.getState().draft).concentration.value).toBe('15.0')
    })

    it('updates field unit', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { unit: 'µM' })
      expect(occupancyDraftOf(store.getState().draft).concentration.unit).toBe('µM')
    })

    it('clears source when value changes', () => {
      const store = setupStore()
      // Manually set a field with source (source is only built by a library
      // load in production — here we construct it directly for the test).
      const draft = occupancyDraftOf(store.getState().draft)
      const concentration: ParameterDraft = {
        ...draft.concentration,
        source: { provenance: { type: 'literature', source: 'Test' }, originLabel: 'Test' },
      }
      store.setState({ draft: { ...draft, concentration } })

      store.getState().setDraftField('concentration', { value: '20.0' })
      expect(getDraftField(store.getState().draft, 'concentration')?.source).toBeUndefined()
    })

    it('clears source when unit changes', () => {
      const store = setupStore()
      const draft = occupancyDraftOf(store.getState().draft)
      const concentration: ParameterDraft = {
        ...draft.concentration,
        source: { provenance: { type: 'literature', source: 'Test' }, originLabel: 'Test' },
      }
      store.setState({ draft: { ...draft, concentration } })

      store.getState().setDraftField('concentration', { unit: 'µM' })
      expect(getDraftField(store.getState().draft, 'concentration')?.source).toBeUndefined()
    })

    it('marks stale when report exists and value changes', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      expect(store.getState().stale).toBe(false)
      expect(store.getState().report).not.toBeNull()

      store.getState().setDraftField('concentration', { value: '20.0' })
      expect(store.getState().stale).toBe(true)
    })

    it('does not mark stale when no report exists', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4' })
      expect(store.getState().stale).toBe(false)
    })

    it('clears Zod errors on edit', () => {
      const store = setupStore()
      // Trigger Zod error by calculating with empty fields
      store.getState().calculate()
      expect(Object.keys(store.getState().draftErrors).length).toBeGreaterThan(0)

      store.getState().setDraftField('concentration', { value: '12.4' })
      expect(store.getState().draftErrors).toEqual({})
    })

    it('marks curveSettingsStale after calculation (no curve generated yet)', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      // After calculation, curveSettingsStale is true because a new report exists but no curve has been generated
      expect(store.getState().curveSettingsStale).toBe(true)

      store.getState().setDraftField('concentration', { value: '20.0' })
      expect(store.getState().curveSettingsStale).toBe(true)
    })
  })

  describe('loadFromLibrary', () => {
    it('loads value, unit, and source', () => {
      const store = setupStore()
      store.getState().loadFromLibrary('kd', {
        key: 'test:kd',
        label: 'TEST-R · Kd',
        value: 4.7,
        unit: 'nM',
        provenance: { type: 'literature', source: 'ChEMBL' },
      })

      const draft = occupancyDraftOf(store.getState().draft)
      expect(draft.kd.value).toBe('4.7')
      expect(draft.kd.unit).toBe('nM')
      expect(getDraftField(draft, 'kd')?.source).toBeDefined()
      expect(getDraftField(draft, 'kd')?.source?.originLabel).toBe('TEST-R · Kd')
    })

    it('marks stale when report exists and value changes', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().loadFromLibrary('kd', {
        key: 'test:kd',
        label: 'TEST-R · Kd',
        value: 20.0, // Different value
        unit: 'nM',
        provenance: { type: 'literature', source: 'ChEMBL' },
      })

      expect(store.getState().stale).toBe(true)
    })

    it('does not mark stale when no report exists', () => {
      const store = setupStore()
      store.getState().loadFromLibrary('kd', {
        key: 'test:kd',
        label: 'TEST-R · Kd',
        value: 4.7,
        unit: 'nM',
        provenance: { type: 'literature', source: 'ChEMBL' },
      })
      expect(store.getState().stale).toBe(false)
    })

    it('does not mark stale when loaded value equals current value', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().loadFromLibrary('kd', {
        key: 'test:kd',
        label: 'TEST-R · Kd',
        value: 4.7, // Same value
        unit: 'nM',
        provenance: { type: 'literature', source: 'ChEMBL' },
      })

      expect(store.getState().stale).toBe(false)
    })

    it('clears field errors', () => {
      const store = setupStore()
      store.getState().calculate() // Triggers Zod errors
      expect(Object.keys(store.getState().draftErrors).length).toBeGreaterThan(0)

      store.getState().loadFromLibrary('concentration', {
        key: 'test:conc',
        label: 'Test',
        value: 12.4,
        unit: 'nM',
        provenance: { type: 'literature', source: 'Test' },
      })
      expect(store.getState().draftErrors).toEqual({})
      expect(store.getState().draftIssues).toEqual([])
    })

    it('marks curveSettingsStale when report exists', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().loadFromLibrary('kd', {
        key: 'test:kd',
        label: 'TEST-R · Kd',
        value: 20.0,
        unit: 'nM',
        provenance: { type: 'literature', source: 'ChEMBL' },
      })

      expect(store.getState().curveSettingsStale).toBe(true)
    })
  })

  describe('setPKMode', () => {
    it('switches PK mode from halfLife to k', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      expect(pkHalfLifeDraftOf(store.getState().draft).mode).toBe('halfLife')

      store.getState().setPKMode('k')
      expect(pkKDraftOf(store.getState().draft).mode).toBe('k')
    })

    it('switches PK mode from k to halfLife', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      store.getState().setPKMode('k')

      store.getState().setPKMode('halfLife')
      expect(pkHalfLifeDraftOf(store.getState().draft).mode).toBe('halfLife')
    })

    it('preserves field values when switching mode', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      store.getState().setDraftField('c0', { value: '100', unit: 'nM' })
      store.getState().setDraftField('time', { value: '8', unit: 'h' })
      store.getState().setDraftField('halfLife', { value: '8', unit: 'h' })
      store.getState().setDraftField('k', { value: '0.0866', unit: '1/h' })

      store.getState().setPKMode('k')
      expect(pkDraftOf(store.getState().draft).c0.value).toBe('100')
      expect(pkKDraftOf(store.getState().draft).k.value).toBe('0.0866')

      store.getState().setPKMode('halfLife')
      expect(pkHalfLifeDraftOf(store.getState().draft).halfLife.value).toBe('8')
    })

    it('marks stale when report exists', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      store.getState().setDraftField('c0', { value: '100', unit: 'nM' })
      store.getState().setDraftField('time', { value: '8', unit: 'h' })
      store.getState().setDraftField('halfLife', { value: '8', unit: 'h' })
      store.getState().calculate()

      expect(store.getState().stale).toBe(false)

      store.getState().setPKMode('k')
      expect(store.getState().stale).toBe(true)
    })

    it('marks curveSettingsStale when report exists', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      store.getState().setDraftField('c0', { value: '100', unit: 'nM' })
      store.getState().setDraftField('time', { value: '8', unit: 'h' })
      store.getState().setDraftField('halfLife', { value: '8', unit: 'h' })
      store.getState().calculate()

      store.getState().setPKMode('k')
      expect(store.getState().curveSettingsStale).toBe(true)
    })

    it('clears field errors', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      store.getState().calculate() // Zod errors
      expect(Object.keys(store.getState().draftErrors).length).toBeGreaterThan(0)

      store.getState().setPKMode('k')
      expect(store.getState().draftErrors).toEqual({})
    })

    it('does nothing for non-PK models', () => {
      const store = setupStore()
      store.getState().setPKMode('k')
      expect(store.getState().draft.model).toBe('occupancy.single-site')
    })
  })

  describe('calculate', () => {
    it('validates with Zod first', () => {
      const store = setupStore()
      store.getState().calculate()
      expect(store.getState().report).toBeNull()
      expect(Object.keys(store.getState().draftErrors).length).toBeGreaterThan(0)
    })

    it('calculates occupancy successfully', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      expect(store.getState().report?.ok).toBe(true)
      expect(store.getState().stale).toBe(false)
      expect(store.getState().fieldErrors).toEqual({})
    })

    it('calculates PK successfully', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      store.getState().setDraftField('c0', { value: '100', unit: 'nM' })
      store.getState().setDraftField('time', { value: '8', unit: 'h' })
      store.getState().setDraftField('halfLife', { value: '8', unit: 'h' })
      store.getState().calculate()

      expect(store.getState().report?.ok).toBe(true)
    })

    it('calculates Hill successfully', () => {
      const store = setupStore()
      store.getState().setModel('dose-response.hill')
      store.getState().setDraftField('e0', { value: '0', unit: '%' })
      store.getState().setDraftField('emax', { value: '100', unit: '%' })
      store.getState().setDraftField('ec50', { value: '10', unit: 'nM' })
      store.getState().setDraftField('hillCoefficient', { value: '1', unit: '' })
      store.getState().setDraftField('concentration', { value: '10', unit: 'nM' })
      store.getState().calculate()

      expect(store.getState().report?.ok).toBe(true)
    })

    it('returns field-mapped errors for invalid inputs', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '0', unit: 'nM' }) // Kd must be positive
      store.getState().calculate()

      expect(store.getState().report?.ok).toBe(false)
      if (!store.getState().report?.ok) {
        expect(store.getState().fieldErrors.kd).toBeDefined()
      }
    })

    it('does NOT auto-generate curve after calculation', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      // Curve should be null, not generated
      expect(store.getState().curve).toBeNull()
      expect(store.getState().curveSettingsStale).toBe(true) // Settings are stale because no curve generated
    })
  })

  describe('applyCurveSettings', () => {
    it('does nothing when no valid report', () => {
      const store = setupStore()
      store.getState().applyCurveSettings()
      expect(store.getState().curve).toBeNull()
    })

    it('returns null curve when range not configured', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().applyCurveSettings()
      expect(store.getState().curve).toBeNull()
      expect(store.getState().curveErrors).toEqual([])
      expect(store.getState().curveSettingsStale).toBe(false)
    })

    it('generates curve when range configured', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().setRange({ min: '0.1', max: '100' })
      store.getState().applyCurveSettings()

      expect(store.getState().curve).not.toBeNull()
      expect(store.getState().curveErrors).toEqual([])
      expect(store.getState().curveSettingsStale).toBe(false)
    })

    it('returns curve errors for invalid range', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().setRange({ min: '100', max: '0.1' }) // min > max
      store.getState().applyCurveSettings()

      expect(store.getState().curve).toBeNull()
      expect(store.getState().curveErrors.length).toBeGreaterThan(0)
      expect(store.getState().curveSettingsStale).toBe(false)
    })

    it('rejects log x-axis with min <= 0', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().setRange({ min: '0', max: '100' })
      store.getState().setXScale('log')
      store.getState().applyCurveSettings()

      expect(store.getState().curve).toBeNull()
      expect(store.getState().curveErrors.some((e) => e.message.includes('log x-axis requires range.min > 0'))).toBe(true)
    })

    it('clears curveSettingsStale on success', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().setRange({ min: '0.1', max: '100' })
      expect(store.getState().curveSettingsStale).toBe(true)

      store.getState().applyCurveSettings()
      expect(store.getState().curveSettingsStale).toBe(false)
    })

    it('clears curveSettingsStale on validation error', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().setRange({ min: '100', max: '0.1' })
      store.getState().applyCurveSettings()
      expect(store.getState().curveSettingsStale).toBe(false)
    })
  })

  describe('curve settings stale tracking', () => {
    it('marks curveSettingsStale on range change', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().setRange({ min: '0.1' })
      expect(store.getState().curveSettingsStale).toBe(true)
    })

    it('auto-applies curve on xScale change and clears stale', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      // Need to set range first for auto-apply to work
      store.getState().setRange({ min: '0.1', max: '100' })
      store.getState().setXScale('linear')
      expect(store.getState().curveSettingsStale).toBe(false)
      expect(store.getState().curve).not.toBeNull()
    })

    it('auto-applies curve on yScale change and clears stale', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().setRange({ min: '0.1', max: '100' })
      store.getState().setYScale('log')
      expect(store.getState().curveSettingsStale).toBe(false)
      expect(store.getState().curve).not.toBeNull()
    })

    it('does not mark curveSettingsStale when no report', () => {
      const store = setupStore()
      store.getState().setRange({ min: '0.1', max: '100' })
      expect(store.getState().curveSettingsStale).toBe(false)
    })
  })

  describe('resetInputs', () => {
    it('clears all draft fields to empty', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().resetInputs()

      const draft = occupancyDraftOf(store.getState().draft)
      expect(draft.concentration.value).toBe('')
      expect(draft.kd.value).toBe('')
    })

    it('clears all results', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().resetInputs()
      expect(store.getState().report).toBeNull()
      expect(store.getState().curve).toBeNull()
      expect(store.getState().stale).toBe(false)
    })

    it('preserves model', () => {
      const store = setupStore()
      store.getState().setModel('pk.first-order-one-compartment')
      store.getState().resetInputs()
      expect(store.getState().draft.model).toBe('pk.first-order-one-compartment')
    })
  })

  describe('applyUrlParams', () => {
    it('applies model from URL', () => {
      const store = setupStore()
      store.getState().applyUrlParams({ model: 'pk.first-order-one-compartment', drug: null })
      expect(store.getState().draft.model).toBe('pk.first-order-one-compartment')
    })

    it('applies drug from URL', () => {
      const store = setupStore()
      store.getState().applyUrlParams({ model: null, drug: 'test-drug-123' })
      expect(store.getState().drugId).toBe('test-drug-123')
    })

    it('clears results when model changes via URL', () => {
      const store = setupStore()
      store.getState().setDraftField('concentration', { value: '12.4', unit: 'nM' })
      store.getState().setDraftField('kd', { value: '4.7', unit: 'nM' })
      store.getState().calculate()

      store.getState().applyUrlParams({ model: 'pk.first-order-one-compartment', drug: null })
      expect(store.getState().report).toBeNull()
    })
  })
})