import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { unitCatalog } from '../../domain/pharmacology/unit-catalog'
import {
  CONCENTRATION_DIMENSIONS,
  checkUnitFor,
  convertDecimal,
  dimensionLabel,
  parseRateUnit,
  rateUnitSymbol,
} from './units'

const nM = unitCatalog.get('nM')!
const uM = unitCatalog.get('µM')!
const h = unitCatalog.get('h')!

describe('checkUnitFor', () => {
  it('accepts a catalog unit of an expected dimension', () => {
    const check = checkUnitFor('nM', CONCENTRATION_DIMENSIONS)
    expect(check.reason).toBe('ok')
    if (check.reason === 'ok') expect(check.def.symbol).toBe('nM')
  })

  it('reports missing for blank or absent units', () => {
    expect(checkUnitFor(undefined, CONCENTRATION_DIMENSIONS).reason).toBe('missing')
    expect(checkUnitFor('', CONCENTRATION_DIMENSIONS).reason).toBe('missing')
    expect(checkUnitFor('   ', CONCENTRATION_DIMENSIONS).reason).toBe('missing')
  })

  it('reports unknown for symbols outside the catalog', () => {
    expect(checkUnitFor('molars', CONCENTRATION_DIMENSIONS).reason).toBe('unknown')
  })

  it('reports wrong-dimension for a known unit of another dimension', () => {
    const check = checkUnitFor('h', CONCENTRATION_DIMENSIONS)
    expect(check.reason).toBe('wrong-dimension')
    if (check.reason === 'wrong-dimension') expect(check.actual).toBe('time')
  })

  it('distinguishes molar from mass concentration', () => {
    expect(checkUnitFor('mg/L', CONCENTRATION_DIMENSIONS).reason).toBe('ok')
    // …but not time:
    expect(checkUnitFor('min', CONCENTRATION_DIMENSIONS).reason).toBe('wrong-dimension')
  })
})

describe('convertDecimal', () => {
  it('converts molar units exactly', () => {
    expect(convertDecimal(new Decimal(4.7), nM, uM).toNumber()).toBe(0.0047)
    expect(convertDecimal(new Decimal(1000), nM, uM).toNumber()).toBe(1)
  })

  it('is the identity for the same unit', () => {
    const value = new Decimal(12.4)
    expect(convertDecimal(value, nM, nM)).toBe(value)
  })

  it('converts time units within report precision', () => {
    const hours = unitCatalog.get('h')!
    const minutes = unitCatalog.get('min')!
    expect(convertDecimal(new Decimal(1), hours, minutes).toNumber()).toBeCloseTo(60, 10)
    expect(convertDecimal(new Decimal(30), minutes, hours).toNumber()).toBeCloseTo(0.5, 12)
  })
})

describe('parseRateUnit', () => {
  it('parses "1/<time>" and "<time>^-1" into the time unit behind the rate', () => {
    expect(parseRateUnit('1/h')?.symbol).toBe('h')
    expect(parseRateUnit('1/min')?.symbol).toBe('min')
    expect(parseRateUnit('h^-1')?.symbol).toBe('h')
    expect(parseRateUnit(' 1/s ')?.symbol).toBe('s')
  })

  it('rejects non-rate units', () => {
    expect(parseRateUnit('nM')).toBeUndefined()
    expect(parseRateUnit('h')).toBeUndefined()
    expect(parseRateUnit('1/xyz')).toBeUndefined()
    expect(parseRateUnit('1/µM')).toBeUndefined() // not a time unit
    expect(parseRateUnit('')).toBeUndefined()
  })

  it('renders canonical rate symbols', () => {
    expect(rateUnitSymbol(h)).toBe('1/h')
    expect(rateUnitSymbol(unitCatalog.get('min')!)).toBe('1/min')
  })
})

describe('dimensionLabel', () => {
  it('names every dimension for messages', () => {
    expect(dimensionLabel('molar-concentration')).toBe('molar concentration')
    expect(dimensionLabel('mass-concentration')).toBe('mass concentration')
    expect(dimensionLabel('time')).toBe('time')
    expect(dimensionLabel('dimensionless')).toBe('dimensionless')
    expect(dimensionLabel('rate')).toBe('rate')
  })
})
