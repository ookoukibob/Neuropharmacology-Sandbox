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
    // Mass units are deliberately not in the catalog: no MVP model converts them.
    expect(unitCatalog.has('g')).toBe(false)
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
