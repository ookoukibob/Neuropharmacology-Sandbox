import { describe, expect, it } from 'vitest'
import { FIRST_ORDER_PK, HILL_RESPONSE, MODELS, SINGLE_SITE_OCCUPANCY } from './registry'

describe('model registry', () => {
  it('exposes one descriptor for every ModelId', () => {
    expect(Object.keys(MODELS).sort()).toEqual([
      'dose-response.hill',
      'occupancy.single-site',
      'pk.first-order-one-compartment',
    ])
  })

  it('keeps map keys and descriptor ids in sync (drift guard)', () => {
    for (const descriptor of [FIRST_ORDER_PK, SINGLE_SITE_OCCUPANCY, HILL_RESPONSE]) {
      expect(MODELS[descriptor.id]).toBe(descriptor)
    }
  })

  it('descriptors carry label, formula, assumptions and boundary warnings', () => {
    for (const descriptor of [FIRST_ORDER_PK, SINGLE_SITE_OCCUPANCY, HILL_RESPONSE]) {
      expect(descriptor.label.length).toBeGreaterThan(0)
      expect(descriptor.formula.length).toBeGreaterThan(0)
      expect(descriptor.assumptions.length).toBeGreaterThanOrEqual(3)
      const codes = descriptor.warnings.map((w) => w.code)
      expect(codes).toContain('MODEL_LIMITATION')
      expect(codes).toContain('MODEL_RESULT_NOT_CLINICAL')
      for (const warning of descriptor.warnings) {
        expect(['info', 'warning']).toContain(warning.severity)
        expect(warning.message.length).toBeGreaterThan(0)
      }
    }
  })

  it('state model-specific parameter discipline in assumptions', () => {
    expect(FIRST_ORDER_PK.assumptions.some((a) => a.includes('first-order'))).toBe(true)
    expect(SINGLE_SITE_OCCUPANCY.assumptions.some((a) => a.includes('never substituted for Kd'))).toBe(true)
    expect(HILL_RESPONSE.assumptions.some((a) => a.includes('no default Hill coefficient'))).toBe(true)
    expect(HILL_RESPONSE.assumptions.some((a) => a.includes('IC50'))).toBe(true)
  })
})
