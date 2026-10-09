/**
 * Preference schema tests (phase 9B): structure, value formats, engine
 * cross-field rules, defaulting and merging. Everything here is synthetic —
 * no pharmacological value is ever invented for a test.
 */
import { describe, expect, it } from 'vitest'
import {
  crossRangeError,
  rangeFieldError,
  toStoredPreferences,
  validatePreferences,
} from './schema'
import { defaultCalculatorSettings } from '@/features/calculator/store'
import type { CurveSettings } from '@/features/calculator/store'
import type { ModelId } from '@/engine'

function completeRecord(): Record<string, unknown> {
  return {
    version: 1,
    theme: 'dark',
    calculator: {
      settings: {
        'pk.first-order-one-compartment': {
          range: { min: '0.10', max: '24', points: '250' },
          xScale: 'linear',
          yScale: 'log',
        },
        'occupancy.single-site': {
          range: { min: '', max: '', points: '' },
          xScale: 'log',
          yScale: 'linear',
        },
        'dose-response.hill': {
          range: { min: '0.01', max: '100', points: '' },
          xScale: 'log',
          yScale: 'linear',
        },
      },
    },
  }
}

describe('validatePreferences', () => {
  it('accepts a complete stored record and preserves string forms verbatim', () => {
    const result = validatePreferences(completeRecord())
    if (!result.ok) throw new Error('expected the record to validate')
    expect(result.preferences.theme).toBe('dark')
    const pk = result.preferences.calculator.settings['pk.first-order-one-compartment']
    expect(pk.range).toEqual({ min: '0.10', max: '24', points: '250' })
    expect(pk.yScale).toBe('log')
  })

  it('fills missing models with the application defaults', () => {
    const result = validatePreferences({
      version: 1,
      theme: 'system',
      calculator: {
        settings: {
          'occupancy.single-site': { xScale: 'linear' },
        },
      },
    })
    if (!result.ok) throw new Error('expected the record to validate')
    const settings = result.preferences.calculator.settings
    expect(settings['occupancy.single-site'].xScale).toBe('linear')
    // Partial entry: the untouched leaves come from the same defaults the
    // calculator itself starts with.
    expect(settings['occupancy.single-site'].range).toEqual({ min: '', max: '', points: '' })
    expect(settings['pk.first-order-one-compartment']).toEqual(
      defaultCalculatorSettings()['pk.first-order-one-compartment'],
    )
  })

  it('strips unknown model identifiers instead of applying them', () => {
    const record = completeRecord() as {
      calculator: { settings: Record<string, unknown> }
    }
    record.calculator.settings['pk.future-model'] = {
      range: { min: '1', max: '2', points: '' },
      xScale: 'linear',
      yScale: 'linear',
    }
    const result = validatePreferences(record)
    if (!result.ok) throw new Error('expected the record to validate')
    expect(Object.keys(result.preferences.calculator.settings).sort()).toEqual([
      'dose-response.hill',
      'occupancy.single-site',
      'pk.first-order-one-compartment',
    ])
  })

  it('rejects an unsupported schema version', () => {
    expect(validatePreferences({ ...completeRecord(), version: 2 }).ok).toBe(false)
    expect(validatePreferences({ ...completeRecord(), version: '1' }).ok).toBe(false)
    expect(validatePreferences({ ...completeRecord(), version: undefined }).ok).toBe(false)
  })

  it('rejects invalid theme values and non-object payloads', () => {
    expect(validatePreferences({ ...completeRecord(), theme: 'neon' }).ok).toBe(false)
    expect(validatePreferences(null).ok).toBe(false)
    expect(validatePreferences(42).ok).toBe(false)
    expect(validatePreferences(['theme']).ok).toBe(false)
  })

  it('rejects invalid scale values', () => {
    const record = completeRecord() as {
      calculator: { settings: Record<string, { xScale?: string }> }
    }
    record.calculator.settings['occupancy.single-site'] = { xScale: 'sqrt' }
    expect(validatePreferences(record).ok).toBe(false)
  })

  it('rejects malformed range value types', () => {
    const record = completeRecord() as {
      calculator: { settings: Record<string, unknown> }
    }
    record.calculator.settings['occupancy.single-site'] = {
      range: { min: 42, max: '', points: '' },
      xScale: 'log',
      yScale: 'linear',
    }
    expect(validatePreferences(record).ok).toBe(false)
  })

  it('rejects non-numeric or negative range text', () => {
    for (const min of ['abc', '-1', '12..3']) {
      const record = completeRecord() as {
        calculator: { settings: Record<string, unknown> }
      }
      record.calculator.settings['occupancy.single-site'] = {
        range: { min, max: '', points: '' },
        xScale: 'linear',
        yScale: 'linear',
      }
      expect(validatePreferences(record).ok, `min ${min}`).toBe(false)
    }
  })

  it('rejects points outside the engine bounds or in the wrong format', () => {
    for (const points of ['1', '1000000', 'abc', '2.5']) {
      const record = completeRecord() as {
        calculator: { settings: Record<string, unknown> }
      }
      record.calculator.settings['occupancy.single-site'] = {
        range: { min: '', max: '', points },
        xScale: 'linear',
        yScale: 'linear',
      }
      expect(validatePreferences(record).ok, `points ${points}`).toBe(false)
    }
  })

  it('rejects a fully entered range the engine would reject', () => {
    const record = completeRecord() as {
      calculator: { settings: Record<string, unknown> }
    }
    record.calculator.settings['occupancy.single-site'] = {
      range: { min: '10', max: '5', points: '' },
      xScale: 'linear',
      yScale: 'linear',
    }
    expect(validatePreferences(record).ok).toBe(false)
  })

  it('rejects a log x-axis with a zero minimum', () => {
    const record = completeRecord() as {
      calculator: { settings: Record<string, unknown> }
    }
    record.calculator.settings['occupancy.single-site'] = {
      range: { min: '0', max: '10', points: '' },
      xScale: 'log',
      yScale: 'linear',
    }
    expect(validatePreferences(record).ok).toBe(false)
  })

  it('accepts blank range fields — nothing configured is the default state', () => {
    const defaults = defaultCalculatorSettings()
    expect(toStoredPreferences('system', defaults)).not.toBeNull()
  })
})

describe('crossRangeError', () => {
  const base: CurveSettings = {
    range: { min: '', max: '', points: '' },
    xScale: 'linear',
    yScale: 'linear',
  }

  it('returns null when the range is blank or partially entered', () => {
    expect(crossRangeError(base)).toBeNull()
    expect(crossRangeError({ ...base, range: { min: '1', max: '', points: '' } })).toBeNull()
  })

  it('returns null for a valid explicit range', () => {
    expect(
      crossRangeError({ ...base, range: { min: '0.1', max: '100', points: '250' } }),
    ).toBeNull()
  })

  it("surfaces the engine's message when min is not less than max", () => {
    const error = crossRangeError({
      ...base,
      range: { min: '10', max: '5', points: '' },
    })
    expect(error).toContain('must be less than')
  })
})

describe('rangeFieldError', () => {
  it('accepts blank and well-formed values', () => {
    expect(rangeFieldError('min', '')).toBeNull()
    expect(rangeFieldError('min', '0.10')).toBeNull()
    expect(rangeFieldError('points', '250')).toBeNull()
  })

  it('rejects text that is not a finite non-negative number', () => {
    expect(rangeFieldError('min', 'abc')).not.toBeNull()
    expect(rangeFieldError('min', '-3')).not.toBeNull()
    expect(rangeFieldError('points', '2.5')).not.toBeNull()
    expect(rangeFieldError('points', '1000000')).not.toBeNull()
  })
})

describe('toStoredPreferences', () => {
  it('normalizes a valid candidate into a complete record', () => {
    const settings = defaultCalculatorSettings()
    const record = toStoredPreferences('light', settings)
    expect(record).not.toBeNull()
    expect(record?.theme).toBe('light')
    expect(record?.version).toBe(1)
    expect(Object.keys(record?.calculator.settings ?? {}).sort()).toEqual([
      'dose-response.hill',
      'occupancy.single-site',
      'pk.first-order-one-compartment',
    ])
  })

  it('returns null for a candidate that would not survive a reload', () => {
    const settings = defaultCalculatorSettings()
    const broken: Record<ModelId, CurveSettings> = { ...settings }
    broken['occupancy.single-site'] = {
      range: { min: 'abc', max: '', points: '' },
      xScale: 'log',
      yScale: 'linear',
    }
    expect(toStoredPreferences('dark', broken)).toBeNull()
  })
})
