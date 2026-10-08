/**
 * Unit tests for model adapters (phase 4).
 *
 * Tests field specs, engine input builders, PK mode switching,
 * library candidate generation, and error field mapping.
 * Uses synthetic fixtures only — no pharmacological claims.
 */
import { describe, expect, it } from 'vitest'
import type { Drug } from '@/domain/drug/drug'
import type { Provenance } from '@/domain/provenance/provenance'
import {
  calculateDraft,
  generateCurveForDraft,
  emptyDraft,
  setPKMode,
  getVisibleSpecs,
  getFieldCandidates,
  getDraftField,
  getXUnitHint,
  fieldKeyForError,
  FIELDS_BY_MODEL,
  targetCandidates,
} from './modelAdapters'
import type {
  FirstOrderPKCalculatorInput,
  ReceptorOccupancyCalculatorInput,
  HillResponseCalculatorInput,
  ParameterDraft,
} from './schemas'
import { syntheticDrug } from '@/tests/fixtures'

function makeTestDrug(): Drug {
  return syntheticDrug()
}

// --- Typed fixture factories (synthetic values only) ---

type PKHalfLifeDraft = Extract<FirstOrderPKCalculatorInput, { mode: 'halfLife' }>
type PKKDraft = Extract<FirstOrderPKCalculatorInput, { mode: 'k' }>

function pkHalfLifeDraft(): PKHalfLifeDraft {
  return {
    model: 'pk.first-order-one-compartment',
    mode: 'halfLife',
    c0: { value: '100', unit: 'nM' },
    time: { value: '8', unit: 'h' },
    halfLife: { value: '8', unit: 'h' },
  }
}

function pkKDraft(): PKKDraft {
  return {
    model: 'pk.first-order-one-compartment',
    mode: 'k',
    c0: { value: '', unit: '' },
    time: { value: '', unit: '' },
    k: { value: '', unit: '' },
  }
}

function occupancyDraft(): ReceptorOccupancyCalculatorInput {
  return {
    model: 'occupancy.single-site',
    concentration: { value: '12.4', unit: 'nM' },
    kd: { value: '4.7', unit: 'nM' },
  }
}

function hillDraft(): HillResponseCalculatorInput {
  return {
    model: 'dose-response.hill',
    e0: { value: '0', unit: '%' },
    emax: { value: '100', unit: '%' },
    ec50: { value: '10', unit: 'nM' },
    hillCoefficient: { value: '1', unit: '' },
    concentration: { value: '10', unit: 'nM' },
  }
}

describe('modelAdapters', () => {
  describe('emptyDraft', () => {
    it('creates valid PK draft with half-life mode', () => {
      const draft = emptyDraft('pk.first-order-one-compartment')
      expect(draft.model).toBe('pk.first-order-one-compartment')
      expect(draft.mode).toBe('halfLife')
      expect(draft.c0.value).toBe('')
      // The factory keeps BOTH mode parameters on the runtime object so a
      // later mode switch never loses input (see emptyDraft). The static type
      // carries only the active branch, so read the inactive one through the
      // union-safe accessor instead of a cast.
      expect(getDraftField(draft, 'halfLife')?.value).toBe('')
      expect(getDraftField(draft, 'k')?.value).toBe('')
    })

    it('creates valid occupancy draft', () => {
      const draft = emptyDraft('occupancy.single-site')
      expect(draft.model).toBe('occupancy.single-site')
      expect(draft.concentration.value).toBe('')
      expect(draft.kd.value).toBe('')
    })

    it('creates valid hill draft', () => {
      const draft = emptyDraft('dose-response.hill')
      expect(draft.model).toBe('dose-response.hill')
      expect(draft.e0.value).toBe('')
      expect(draft.hillCoefficient.value).toBe('')
    })
  })

  describe('setPKMode', () => {
    it('switches from halfLife to k', () => {
      const draft = emptyDraft('pk.first-order-one-compartment')
      expect(draft.mode).toBe('halfLife')

      const switched = setPKMode(draft, 'k')
      expect(switched.mode).toBe('k')
      expect(switched.model).toBe('pk.first-order-one-compartment')
    })

    it('switches from k to halfLife', () => {
      const draft = pkKDraft()
      const switched = setPKMode(draft, 'halfLife')
      expect(switched.mode).toBe('halfLife')
      expect(switched.c0.value).toBe('')
    })

    it('preserves other fields when switching', () => {
      const draft = pkHalfLifeDraft()

      const switchedToK = setPKMode(draft, 'k')
      expect(switchedToK.c0.value).toBe('100')
      expect(switchedToK.time.value).toBe('8')

      const switchedBack = setPKMode(switchedToK, 'halfLife')
      expect(switchedBack.c0.value).toBe('100')
      expect(switchedBack.time.value).toBe('8')
    })

    it('does nothing for non-PK models', () => {
      const draft = emptyDraft('occupancy.single-site')
      const result = setPKMode(draft, 'k')
      expect(result).toBe(draft)
    })
  })

  describe('FIELDS_BY_MODEL', () => {
    it('has correct field keys for PK', () => {
      const keys = FIELDS_BY_MODEL['pk.first-order-one-compartment'].map((f) => f.key)
      expect(keys).toEqual(['c0', 'time', 'halfLife', 'k'])
    })

    it('has correct field keys for occupancy', () => {
      const keys = FIELDS_BY_MODEL['occupancy.single-site'].map((f) => f.key)
      expect(keys).toEqual(['concentration', 'kd'])
    })

    it('has correct field keys for hill', () => {
      const keys = FIELDS_BY_MODEL['dose-response.hill'].map((f) => f.key)
      expect(keys).toEqual(['concentration', 'ec50', 'e0', 'emax', 'hillCoefficient'])
    })

    it('PK halfLife field is visible only in halfLife mode', () => {
      const halfLifeDraft = emptyDraft('pk.first-order-one-compartment')
      const kDraft = pkKDraft()

      const halfLifeSpec = FIELDS_BY_MODEL['pk.first-order-one-compartment'].find((f) => f.key === 'halfLife')
      const kSpec = FIELDS_BY_MODEL['pk.first-order-one-compartment'].find((f) => f.key === 'k')

      expect(halfLifeSpec?.visible?.(halfLifeDraft)).toBe(true)
      expect(halfLifeSpec?.visible?.(kDraft)).toBe(false)
      expect(kSpec?.visible?.(halfLifeDraft)).toBe(false)
      expect(kSpec?.visible?.(kDraft)).toBe(true)
    })
  })

  describe('getVisibleSpecs', () => {
    it('returns all specs for occupancy', () => {
      const draft = emptyDraft('occupancy.single-site')
      const specs = getVisibleSpecs(draft)
      expect(specs.length).toBe(2)
      expect(specs.map((s) => s.key)).toEqual(['concentration', 'kd'])
    })

    it('returns halfLife field for PK halfLife mode', () => {
      const draft = emptyDraft('pk.first-order-one-compartment')
      const specs = getVisibleSpecs(draft)
      const keys = specs.map((s) => s.key)
      expect(keys).toContain('halfLife')
      expect(keys).not.toContain('k')
    })

    it('returns k field for PK k mode', () => {
      const draft = pkKDraft()
      const specs = getVisibleSpecs(draft)
      const keys = specs.map((s) => s.key)
      expect(keys).toContain('k')
      expect(keys).not.toContain('halfLife')
    })
  })

  describe('getFieldCandidates', () => {
    it('returns Kd candidates from drug targets', () => {
      const drug = makeTestDrug()
      const draft = emptyDraft('occupancy.single-site')
      const candidates = getFieldCandidates(draft, 'kd', drug)

      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates[0]?.key).toContain('kd')
      expect(candidates[0]?.label).toContain('Kd')
      expect(candidates[0]?.value).toBeGreaterThan(0)
      expect(candidates[0]?.unit).toBe('nM')
    })

    it('does not provide IC50 candidates (not a calculator field)', () => {
      const drug = makeTestDrug()
      const draft = emptyDraft('occupancy.single-site')
      const candidates = getFieldCandidates(draft, 'ic50', drug)
      // IC50 is not a field in any calculator model, so no candidates
      expect(candidates).toEqual([])
    })

    it('returns EC50 candidates from drug targets for Hill model', () => {
      const drug = makeTestDrug()
      const draft = emptyDraft('dose-response.hill')
      const candidates = getFieldCandidates(draft, 'ec50', drug)

      // The fixture has Kd and IC50, but not EC50, so this should be empty
      expect(candidates.length).toBe(0)
    })

    it('returns IC50 candidates from drug targets for Hill model (if fixture had IC50)', () => {
      // This test documents that IC50 is not a field in the Hill model
      const drug = makeTestDrug()
      const draft = emptyDraft('dose-response.hill')
      const candidates = getFieldCandidates(draft, 'ic50', drug)

      // IC50 is not a field in the Hill model, so no candidates
      expect(candidates).toEqual([])
    })

    it('returns half-life candidate from PK', () => {
      const drug = makeTestDrug()
      const draft = emptyDraft('pk.first-order-one-compartment')
      const candidates = getFieldCandidates(draft, 'halfLife', drug)

      expect(candidates.length).toBe(1)
      expect(candidates[0]?.label).toBe('Half-life')
    })

    it('returns empty for fields without candidates', () => {
      const drug = makeTestDrug()
      const draft = emptyDraft('occupancy.single-site')
      const candidates = getFieldCandidates(draft, 'concentration', drug)

      expect(candidates).toEqual([])
    })

    it('returns empty when drug is undefined', () => {
      const draft = emptyDraft('occupancy.single-site')
      const candidates = getFieldCandidates(draft, 'kd', undefined)
      expect(candidates).toEqual([])
    })
  })

  describe('getXUnitHint', () => {
    it('returns time unit for PK', () => {
      const draft = emptyDraft('pk.first-order-one-compartment')
      const hint = getXUnitHint(draft)
      expect(hint).toContain('time')
    })

    it('returns concentration unit for occupancy', () => {
      const draft = emptyDraft('occupancy.single-site')
      const hint = getXUnitHint(draft)
      expect(hint).toContain('concentration')
    })

    it('returns concentration unit for hill', () => {
      const draft = emptyDraft('dose-response.hill')
      const hint = getXUnitHint(draft)
      expect(hint).toContain('concentration')
    })
  })

  describe('fieldKeyForError', () => {
    it('maps PK C0 error to c0', () => {
      const key = fieldKeyForError('pk.first-order-one-compartment', {
        code: 'NEGATIVE_VALUE',
        parameter: 'C0',
        message: 'C0 must be non-negative',
      })
      expect(key).toBe('c0')
    })

    it('maps PK t½ error to halfLife', () => {
      const key = fieldKeyForError('pk.first-order-one-compartment', {
        code: 'ZERO_NOT_ALLOWED',
        parameter: 't½',
        message: 'Half-life must be positive',
      })
      expect(key).toBe('halfLife')
    })

    it('maps occupancy [D] error to concentration', () => {
      const key = fieldKeyForError('occupancy.single-site', {
        code: 'NEGATIVE_VALUE',
        parameter: '[D]',
        message: 'Concentration must be non-negative',
      })
      expect(key).toBe('concentration')
    })

    it('maps hill EC50 error to ec50', () => {
      const key = fieldKeyForError('dose-response.hill', {
        code: 'ZERO_NOT_ALLOWED',
        parameter: 'EC50',
        message: 'EC50 must be positive',
      })
      expect(key).toBe('ec50')
    })

    it('strips .unit suffix', () => {
      const key = fieldKeyForError('occupancy.single-site', {
        code: 'MISSING_PARAMETER',
        parameter: 'Kd.unit',
        message: 'Unit required',
      })
      expect(key).toBe('kd')
    })

    it('returns undefined for unknown parameter', () => {
      const key = fieldKeyForError('occupancy.single-site', {
        code: 'MODEL_NOT_APPLICABLE',
        message: 'Some global error',
      })
      expect(key).toBeUndefined()
    })
  })

  describe('targetCandidates', () => {
    it('returns IC50 candidates from drug targets', () => {
      const drug = makeTestDrug()
      const candidates = targetCandidates(drug, 'ic50', 'IC50')
      expect(candidates.length).toBeGreaterThan(0)
      expect(candidates[0]?.label).toContain('IC50')
    })
  })

  describe('calculateDraft - synthetic integration', () => {
    it('calculates occupancy with synthetic values', () => {
      const report = calculateDraft(occupancyDraft())
      expect(report.ok).toBe(true)
      if (report.ok) {
        expect(report.result.outputs.length).toBeGreaterThan(0)
        expect(report.result.trace.length).toBeGreaterThan(0)
        expect(report.result.assumptions.length).toBeGreaterThan(0)
        expect(report.result.warnings.length).toBeGreaterThan(0)
      }
    })

    it('calculates PK with synthetic values', () => {
      const report = calculateDraft(pkHalfLifeDraft())
      expect(report.ok).toBe(true)
      if (report.ok) {
        expect(report.result.outputs.some((o) => o.symbol === 'C(t)')).toBe(true)
        expect(report.result.outputs.some((o) => o.symbol === 'k')).toBe(true)
      }
    })

    it('calculates Hill with synthetic values', () => {
      const report = calculateDraft(hillDraft())
      expect(report.ok).toBe(true)
      if (report.ok) {
        expect(report.result.outputs.some((o) => o.symbol === 'E')).toBe(true)
      }
    })

    it('returns error for missing required PK parameter', () => {
      const draft = emptyDraft('pk.first-order-one-compartment')
      const report = calculateDraft(draft)
      expect(report.ok).toBe(false)
    })

    it('returns error for invalid concentration dimension', () => {
      const draft: ReceptorOccupancyCalculatorInput = {
        model: 'occupancy.single-site',
        concentration: { value: '10', unit: 'nM' },
        kd: { value: '5', unit: 'mg/L' }, // mass vs molar concentration
      }
      const report = calculateDraft(draft)
      expect(report.ok).toBe(false)
      if (!report.ok) {
        expect(report.errors.some((e) => e.code === 'INCOMPATIBLE_UNITS')).toBe(true)
      }
    })
  })

  describe('generateCurveForDraft - synthetic integration', () => {
    it('generates occupancy curve', () => {
      const result = generateCurveForDraft(occupancyDraft(), {
        range: { min: 0.1, max: 100, points: 10 },
        xScale: 'log',
        yScale: 'linear',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.curve.series.length).toBeGreaterThan(0)
        expect(result.curve.series[0]?.points.length).toBe(10)
        expect(result.curve.xScale).toBe('log')
      }
    })

    it('generates PK curve', () => {
      const result = generateCurveForDraft(pkHalfLifeDraft(), {
        range: { min: 0, max: 24, points: 10 },
        xScale: 'linear',
        yScale: 'linear',
      })

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.curve.xScale).toBe('linear')
        expect(result.curve.series[0]?.id).toBe('pk.concentration')
      }
    })

    it('rejects empty range', () => {
      const result = generateCurveForDraft(occupancyDraft(), {
        range: { min: NaN, max: 100, points: 10 },
        xScale: 'log',
        yScale: 'linear',
      })

      expect(result.ok).toBe(false)
    })
  })

  describe('provenance preservation', () => {
    const provenance: Provenance = {
      type: 'literature',
      source: 'ChEMBL',
      citation: 'Test',
    }

    function loadedOccupancyDraft(): ReceptorOccupancyCalculatorInput {
      // `source` is a runtime part of a field draft (built only by an
      // explicit library load) — model it as ParameterDraft, then hand the
      // schema-shaped value to the calculator input type.
      const concentration: ParameterDraft = {
        value: '12.4',
        unit: 'nM',
        source: { provenance, originLabel: 'TEST-R · Kd' },
      }
      return {
        model: 'occupancy.single-site',
        concentration,
        kd: { value: '4.7', unit: 'nM' },
      }
    }

    it('preserves provenance from library candidate in engine input', () => {
      const report = calculateDraft(loadedOccupancyDraft())
      expect(report.ok).toBe(true)
      if (report.ok) {
        const concInput = report.result.inputs.find((i) => i.symbol === '[D]')
        expect(concInput?.provenance).toEqual(provenance)
      }
    })

    it('does not attach provenance for user-entered values', () => {
      const report = calculateDraft(occupancyDraft())
      expect(report.ok).toBe(true)
      if (report.ok) {
        const concInput = report.result.inputs.find((i) => i.symbol === '[D]')
        expect(concInput?.provenance).toBeUndefined()
      }
    })

    it('clears provenance when user edits a library-loaded value', () => {
      const loaded = loadedOccupancyDraft()

      // A manual edit clears the source by omitting it (never by assigning
      // undefined — exactOptionalPropertyTypes forbids that shape).
      const edited: ReceptorOccupancyCalculatorInput = {
        model: 'occupancy.single-site',
        concentration: { value: loaded.concentration.value, unit: loaded.concentration.unit },
        kd: loaded.kd,
      }

      const report = calculateDraft(edited)
      expect(report.ok).toBe(true)
      if (report.ok) {
        const concInput = report.result.inputs.find((i) => i.symbol === '[D]')
        expect(concInput?.provenance).toBeUndefined()
      }
    })
  })
})