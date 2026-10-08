/**
 * Unit tests for calculator input schemas (phase 4).
 */
import { describe, expect, it } from 'vitest'
import {
  firstOrderPKCalculatorInputSchema,
  receptorOccupancyCalculatorInputSchema,
  hillResponseCalculatorInputSchema,
  validateDraft,
} from './schemas'

function validPKHalfLife() {
  return {
    model: 'pk.first-order-one-compartment' as const,
    mode: 'halfLife' as const,
    c0: { value: '100', unit: 'nM' },
    time: { value: '8', unit: 'h' },
    halfLife: { value: '8', unit: 'h' },
    k: { value: '', unit: '' },
  }
}

function validPKK() {
  return {
    model: 'pk.first-order-one-compartment' as const,
    mode: 'k' as const,
    c0: { value: '100', unit: 'nM' },
    time: { value: '8', unit: 'h' },
    halfLife: { value: '', unit: '' },
    k: { value: '0.0866', unit: '1/h' },
  }
}

function validOccupancy() {
  return {
    model: 'occupancy.single-site' as const,
    concentration: { value: '12.4', unit: 'nM' },
    kd: { value: '4.7', unit: 'nM' },
  }
}

function validHill() {
  return {
    model: 'dose-response.hill' as const,
    e0: { value: '0', unit: '%' },
    emax: { value: '100', unit: '%' },
    ec50: { value: '10', unit: 'nM' },
    hillCoefficient: { value: '1', unit: '' },
    concentration: { value: '10', unit: 'nM' },
  }
}

describe('calculator input schemas', () => {
  describe('firstOrderPKCalculatorInputSchema', () => {
    it('accepts valid half-life mode', () => {
      const result = firstOrderPKCalculatorInputSchema.safeParse(validPKHalfLife())
      expect(result.success).toBe(true)
    })

    it('accepts valid k mode', () => {
      const result = firstOrderPKCalculatorInputSchema.safeParse(validPKK())
      expect(result.success).toBe(true)
    })

    it('rejects empty half-life in halfLife mode', () => {
      const draft = { ...validPKHalfLife(), halfLife: { value: '', unit: '' } }
      const result = firstOrderPKCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === 'halfLife')).toBe(true)
      }
    })

    it('rejects empty k in k mode', () => {
      const draft = { ...validPKK(), k: { value: '', unit: '' } }
      const result = firstOrderPKCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === 'k')).toBe(true)
      }
    })

    it('rejects non-numeric value', () => {
      const draft = { ...validPKHalfLife(), c0: { value: 'not-a-number', unit: 'nM' } }
      const result = firstOrderPKCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === 'c0')).toBe(true)
      }
    })

    it('rejects missing unit', () => {
      const draft = { ...validPKHalfLife(), c0: { value: '100', unit: '' } }
      const result = firstOrderPKCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
      if (!result.success) {
        expect(result.error.issues.some((i) => i.path[0] === 'c0')).toBe(true)
      }
    })
  })

  describe('receptorOccupancyCalculatorInputSchema', () => {
    it('accepts valid occupancy input', () => {
      const result = receptorOccupancyCalculatorInputSchema.safeParse(validOccupancy())
      expect(result.success).toBe(true)
    })

    it('rejects missing concentration', () => {
      const draft = { ...validOccupancy(), concentration: { value: '', unit: '' } }
      const result = receptorOccupancyCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
    })

    it('rejects missing kd', () => {
      const draft = { ...validOccupancy(), kd: { value: '', unit: '' } }
      const result = receptorOccupancyCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
    })
  })

  describe('hillResponseCalculatorInputSchema', () => {
    it('accepts valid hill input', () => {
      const result = hillResponseCalculatorInputSchema.safeParse(validHill())
      expect(result.success).toBe(true)
    })

    it('rejects missing e0', () => {
      const draft = { ...validHill(), e0: { value: '', unit: '' } }
      const result = hillResponseCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
    })

    it('rejects missing ec50', () => {
      const draft = { ...validHill(), ec50: { value: '', unit: '' } }
      const result = hillResponseCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
    })

    it('rejects missing hill coefficient', () => {
      const draft = { ...validHill(), hillCoefficient: { value: '', unit: '' } }
      const result = hillResponseCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(false)
    })

    it('accepts dimensionless unit for hill coefficient', () => {
      const draft = { ...validHill(), hillCoefficient: { value: '1.5', unit: '1' } }
      const result = hillResponseCalculatorInputSchema.safeParse(draft)
      expect(result.success).toBe(true)
    })
  })

  describe('validateDraft', () => {
    it('returns empty errors for valid PK half-life draft', () => {
      const result = validateDraft(validPKHalfLife())
      expect(result.fields).toEqual({})
      expect(result.issues).toEqual([])
    })

    it('returns field errors for invalid PK draft', () => {
      const draft = { ...validPKHalfLife(), c0: { value: '', unit: '' } }
      const result = validateDraft(draft)
      expect(result.fields.c0).toBeDefined()
    })

    it('returns field errors for invalid occupancy draft', () => {
      const draft = { ...validOccupancy(), kd: { value: '', unit: '' } }
      const result = validateDraft(draft)
      expect(result.fields.kd).toBeDefined()
    })

    it('returns field errors for invalid hill draft', () => {
      const draft = { ...validHill(), ec50: { value: '', unit: '' } }
      const result = validateDraft(draft)
      expect(result.fields.ec50).toBeDefined()
    })
  })
})