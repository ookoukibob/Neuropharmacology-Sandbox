import Decimal from 'decimal.js'
import { describe, expect, it } from 'vitest'
import {
  LN_TWO,
  REPORT_PRECISION_DIGITS,
  formatDecimal,
  formatNumber,
  formatQuantity,
  roundForReport,
} from './decimal'

describe('roundForReport', () => {
  it('rounds to the documented 12 significant digits', () => {
    expect(REPORT_PRECISION_DIGITS).toBe(12)
    const rounded = roundForReport(new Decimal('12.4').div(17.1))
    expect(rounded.loss).toBe('none')
    expect(rounded.value).toBe(0.72514619883) // 12.4/17.1 = 0.7251461988304093…
  })

  it('absorbs binary floating-point artifacts', () => {
    expect(roundForReport(new Decimal(0.1).plus(0.2)).value).toBe(0.3)
    expect(0.1 + 0.2).toBe(0.30000000000000004) // what plain doubles would show
  })

  it('reports exact zeros without loss', () => {
    expect(roundForReport(new Decimal(0))).toEqual({ value: 0, loss: 'none' })
  })

  it('detects underflow: non-zero value that a double reports as 0', () => {
    expect(roundForReport(new Decimal('1e-400'))).toEqual({ value: 0, loss: 'underflow' })
    expect(roundForReport(new Decimal('-1e-400'))).toEqual({ value: 0, loss: 'underflow' })
  })

  it('detects overflow: values beyond the double range', () => {
    const up = roundForReport(new Decimal('1e400'))
    expect(up.loss).toBe('overflow')
    expect(up.value).toBe(Number.POSITIVE_INFINITY)
    const down = roundForReport(new Decimal('-1e400'))
    expect(down.loss).toBe('overflow')
    expect(down.value).toBe(Number.NEGATIVE_INFINITY)
    const infinite = roundForReport(new Decimal(Infinity))
    expect(infinite.loss).toBe('overflow')
  })
})

describe('formatDecimal / formatNumber', () => {
  it('formats at 12 significant digits', () => {
    expect(formatDecimal(new Decimal(12.4))).toBe('12.4')
    expect(formatDecimal(new Decimal('0.5'))).toBe('0.5')
    expect(formatDecimal(new Decimal('12.4').div(17.1))).toBe('0.72514619883')
  })

  it('keeps exponential form for subnormal magnitudes instead of showing 0', () => {
    expect(formatDecimal(new Decimal('1e-400'))).toBe('1e-400')
    expect(formatDecimal(new Decimal('1e+300'))).toBe('1e+300')
  })

  it('formats plain numbers without artifacts and normalizes -0', () => {
    expect(formatNumber(0.1 + 0.2)).toBe('0.3')
    expect(formatNumber(12.4)).toBe('12.4')
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(-0)).toBe('0')
    expect(formatNumber(1e300)).toBe('1e+300')
  })
})

describe('formatQuantity', () => {
  it('appends the unit, but prints dimensionless values bare', () => {
    expect(formatQuantity(12.4, 'nM')).toBe('12.4 nM')
    expect(formatQuantity(new Decimal(4.7), 'nM')).toBe('4.7 nM')
    expect(formatQuantity(0.5, '1')).toBe('0.5')
    expect(formatQuantity(72.5, '%')).toBe('72.5 %')
    expect(formatQuantity(new Decimal(0.115524530093), '1/h')).toBe('0.115524530093 1/h')
  })
})

describe('LN_TWO', () => {
  it('matches the natural logarithm of 2', () => {
    expect(LN_TWO.toNumber()).toBeCloseTo(Math.LN2, 14)
  })
})
