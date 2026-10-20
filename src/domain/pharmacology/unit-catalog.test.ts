import { describe, expect, it } from 'vitest'
import { unitCatalog } from './unit-catalog'

describe('unitCatalog — lookup', () => {
  it('resolves canonical symbols with dimension and factor', () => {
    const nm = unitCatalog.get('nM')
    expect(nm).toBeDefined()
    expect(nm?.symbol).toBe('nM')
    expect(nm?.dimension).toBe('molar-concentration')
    expect(nm?.toBase).toBe(1e-9)
    expect(unitCatalog.dimensionOf('h')).toBe('time')
    expect(unitCatalog.has('µM')).toBe(true)
  })

  it('resolves aliases, case and micro-sign variants to one canonical unit', () => {
    expect(unitCatalog.get('uM')?.symbol).toBe('µM')
    expect(unitCatalog.get('μM')?.symbol).toBe('µM') // Greek small letter mu
    expect(unitCatalog.get('umol/L')?.symbol).toBe('µM')
    expect(unitCatalog.get('nmol/L')?.symbol).toBe('nM')
    expect(unitCatalog.get('mol/L')?.symbol).toBe('M')
    expect(unitCatalog.get('hour')?.symbol).toBe('h')
    expect(unitCatalog.get('  h  ')?.symbol).toBe('h')
    expect(unitCatalog.get('NM')?.symbol).toBe('nM')
  })

  it('keeps nM and µM distinct — never the same unit', () => {
    const nm = unitCatalog.get('nM')
    const um = unitCatalog.get('µM')
    expect(nm).not.toBe(um)
    expect(nm?.toBase).toBe(1e-9)
    expect(um?.toBase).toBe(1e-6)
    // A factor of 1000 separates them (within double representation error).
    expect((um?.toBase ?? 0) / (nm?.toBase ?? 1)).toBeCloseTo(1000, 9)
  })

  it('reports undefined for unknown symbols', () => {
    expect(unitCatalog.get('bananas')).toBeUndefined()
    expect(unitCatalog.has('bananas')).toBe(false)
    expect(unitCatalog.dimensionOf('molars')).toBeUndefined()
    // Phase 41 added mass/volume/clearance/mass-flow units; nothing else.
    expect(unitCatalog.has('stone')).toBe(false)
    expect(unitCatalog.has('L/kg')).toBe(false)
  })
})

describe('unitCatalog — convert', () => {
  it('converts within a dimension', () => {
    const micro = unitCatalog.convert(1000, 'nM', 'µM')
    expect(micro.ok).toBe(true)
    if (micro.ok) expect(micro.value).toBeCloseTo(1, 12)

    const hours = unitCatalog.convert(1, 'd', 'h')
    expect(hours).toEqual({ ok: true, value: 24 })

    const fraction = unitCatalog.convert(50, '%', '1')
    expect(fraction).toEqual({ ok: true, value: 0.5 })

    const minutes = unitCatalog.convert(1, 'h', 'min')
    expect(minutes.ok).toBe(true)
    if (minutes.ok) expect(minutes.value).toBeCloseTo(60, 10)
  })

  it('returns the value unchanged when converting to the same unit', () => {
    expect(unitCatalog.convert(12.4, 'nM', 'nM')).toEqual({ ok: true, value: 12.4 })
  })

  it('rejects unknown units on either side', () => {
    expect(unitCatalog.convert(1, 'molars', 'nM')).toEqual({
      ok: false,
      error: { kind: 'unknown-unit', symbol: 'molars' },
    })
    expect(unitCatalog.convert(1, 'nM', 'furlongs')).toEqual({
      ok: false,
      error: { kind: 'unknown-unit', symbol: 'furlongs' },
    })
  })

  it('refuses conversion across dimensions (molar vs mass, concentration vs time)', () => {
    expect(unitCatalog.convert(1, 'mg/L', 'nM')).toEqual({
      ok: false,
      error: { kind: 'incompatible-units', from: 'mg/L', to: 'nM' },
    })
    expect(unitCatalog.convert(1, 'nM', 'h')).toEqual({
      ok: false,
      error: { kind: 'incompatible-units', from: 'nM', to: 'h' },
    })
  })
})
describe('unitCatalog — phase 41 physical dimensions', () => {
  it('defines mass (base g), volume (base L), clearance (base L/h) and mass-flow rate (base mg/h)', () => {
    expect(unitCatalog.get('mg')).toMatchObject({ symbol: 'mg', dimension: 'mass', toBase: 1e-3 })
    expect(unitCatalog.get('µg')).toMatchObject({ symbol: 'µg', dimension: 'mass', toBase: 1e-6 })
    expect(unitCatalog.get('g')).toMatchObject({ symbol: 'g', dimension: 'mass', toBase: 1 })
    expect(unitCatalog.get('L')).toMatchObject({ symbol: 'L', dimension: 'volume', toBase: 1 })
    expect(unitCatalog.get('mL')).toMatchObject({ symbol: 'mL', dimension: 'volume', toBase: 1e-3 })
    expect(unitCatalog.get('L/h')).toMatchObject({ symbol: 'L/h', dimension: 'clearance', toBase: 1 })
    expect(unitCatalog.get('mg/h')).toMatchObject({ symbol: 'mg/h', dimension: 'mass-flow-rate', toBase: 1 })
  })

  it('keeps every new dimension distinct, including from the existing rate dimension', () => {
    const dimensions = ['mass', 'volume', 'clearance', 'mass-flow-rate']
    expect(new Set(dimensions).size).toBe(4)
    // "1/h" is a rate denominator the engine parses, never a catalog clearance.
    expect(unitCatalog.has('1/h')).toBe(false)
    expect(unitCatalog.dimensionOf('L/h')).toBe('clearance')
    expect(unitCatalog.dimensionOf('mg/h')).toBe('mass-flow-rate')
    for (const symbol of ['g', 'L', 'L/h', 'mg/h']) {
      expect(unitCatalog.dimensionOf(symbol)).not.toBe('time')
      expect(unitCatalog.dimensionOf(symbol)).not.toBe('rate')
    }
  })

  it('converts within each new dimension with physically exact factors', () => {
    // 1 L = 1000 mL
    expect(unitCatalog.convert(1, 'L', 'mL')).toEqual({ ok: true, value: 1000 })
    // 1 g = 1000 mg = 1e6 µg
    expect(unitCatalog.convert(1, 'g', 'mg')).toEqual({ ok: true, value: 1000 })
    const micrograms = unitCatalog.convert(1000, 'µg', 'mg')
    expect(micrograms.ok && micrograms.value).toBeCloseTo(1, 12)
    // 1 mL/min = 0.06 L/h
    const clearance = unitCatalog.convert(1, 'mL/min', 'L/h')
    expect(clearance.ok && clearance.value).toBeCloseTo(0.06, 15)
    // 1 µg/min = 0.06 mg/h
    const flow = unitCatalog.convert(1, 'µg/min', 'mg/h')
    expect(flow.ok && flow.value).toBeCloseTo(0.06, 15)
    expect(unitCatalog.convert(1, 'g/h', 'mg/h')).toEqual({ ok: true, value: 1000 })
    expect(unitCatalog.convert(0.5, 'mg/h', 'µg/min').ok).toBe(true)
  })

  it('refuses every cross-dimension conversion between the new dimensions', () => {
    const pairs: ReadonlyArray<readonly [string, string]> = [
      ['mg', 'L'],
      ['L', 'L/h'],
      ['L/h', 'mg/h'],
      ['mg/h', 'L/h'],
      ['mg/h', 'mg'],
      ['L/h', 'h'],
      ['mg', 'g/L'],
      ['L', 'mg/h'],
    ]
    for (const [from, to] of pairs) {
      const result = unitCatalog.convert(1, from, to)
      expect(result.ok, `${from} → ${to} must be refused`).toBe(false)
      if (!result.ok) expect(result.error.kind).toBe('incompatible-units')
    }
  })

  it('exposes the new units to dimension-driven pickers', () => {
    expect(unitCatalog.unitsOfDimension('mass').map((u) => u.symbol)).toEqual(['g', 'mg', 'µg'])
    expect(unitCatalog.unitsOfDimension('volume').map((u) => u.symbol)).toEqual(['L', 'mL'])
    expect(unitCatalog.unitsOfDimension('clearance').map((u) => u.symbol)).toEqual(['L/h', 'mL/h', 'mL/min'])
    expect(unitCatalog.unitsOfDimension('mass-flow-rate').map((u) => u.symbol)).toEqual([
      'mg/h',
      'µg/h',
      'µg/min',
      'g/h',
    ])
    // The pre-existing dimensions keep their contents.
    expect(unitCatalog.unitsOfDimension('time').map((u) => u.symbol)).toEqual(['s', 'min', 'h', 'd'])
  })

  it('keeps mass-concentration separate from mass and volume', () => {
    expect(unitCatalog.dimensionOf('mg/L')).toBe('mass-concentration')
    const result = unitCatalog.convert(1, 'mg/L', 'mg')
    expect(result.ok).toBe(false)
  })
})
