import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import {
  analyzeNca,
  linearTrapezoid,
  linearUpLogDownTrapezoid,
  logLinearRegression,
  logTrapezoid,
  trapezoidalArea,
  type NcaAnalysis,
  type NcaIntegrationMethod,
  type NcaMetricAvailable,
} from './nca'

const rows = (pairs: readonly (readonly [number, number])[]): ExperimentalMeasurement[] =>
  pairs.map(([time, concentration], index) => ({
    id: `m${String(index + 1)}`,
    sourceRow: index + 1,
    time,
    concentration,
  }))

type NcaMetricKey = 'cmax' | 'tmax' | 'aucLast' | 'aucInf' | 'extrapolatedFraction' | 'lambdaZ' | 'halfLife'

const metric = (analysis: NcaAnalysis, key: NcaMetricKey): NcaMetricAvailable => {
  const value = analysis[key]
  if (value.status !== 'available') {
    throw new Error(`expected ${key} to be available`)
  }
  return value
}

const options = (overrides: Partial<{ integrationMethod: NcaIntegrationMethod; terminalPointCount: number }> = {}) => ({
  integrationMethod: 'linear' as NcaIntegrationMethod,
  terminalPointCount: 3,
  ...overrides,
})

describe('NCA trapezoidal integration', () => {
  it('computes the linear trapezoid against a hand-calculated value', () => {
    expect(linearTrapezoid(0, 100, 1, 50)).toBe(75)
    expect(linearTrapezoid(1, 50, 2, 25)).toBe(37.5)
  })

  it('computes the logarithmic trapezoid against a hand-calculated value', () => {
    // (100 − 50)/ln(2) · 1 = 50 / 0.6931… = 72.134…
    const value = logTrapezoid(0, 100, 1, 50)
    expect(value).not.toBeNull()
    expect(value as number).toBeCloseTo(50 / Math.LN2, 6)
  })

  it('returns null for an undefined logarithmic trapezoid', () => {
    expect(logTrapezoid(0, 0, 1, 50)).toBeNull()
    expect(logTrapezoid(0, 50, 1, 0)).toBeNull()
    expect(logTrapezoid(0, 50, 1, 50)).toBeNull()
  })

  it('applies linear-up/log-down per interval direction', () => {
    // Increasing -> linear.
    expect(linearUpLogDownTrapezoid(0, 50, 1, 100)).toEqual({
      area: 75,
      method: 'linear',
      fellBackToLinear: false,
    })
    // Decreasing -> logarithmic.
    const decreasing = linearUpLogDownTrapezoid(0, 100, 1, 50)
    expect(decreasing.method).toBe('log')
    expect(decreasing.area).toBeCloseTo(50 / Math.LN2, 6)
    // Equal -> linear (log undefined).
    expect(linearUpLogDownTrapezoid(0, 50, 1, 50).area).toBe(50)
    // Decreasing into a zero -> linear fallback, flagged.
    expect(linearUpLogDownTrapezoid(0, 50, 1, 0)).toEqual({
      area: 25,
      method: 'linear',
      fellBackToLinear: true,
    })
  })

  it('integrates a full curve with the linear method', () => {
    // 100, 50, 25 at 0, 1, 2: 75 + 37.5 = 112.5.
    const area = trapezoidalArea(
      rows([
        [0, 100],
        [1, 50],
        [2, 25],
      ]).map((row, index) => ({ time: row.time, concentration: (row as { concentration: number }).concentration, sourceRow: index + 1 })),
      'linear',
    )
    expect(area).not.toBeNull()
    expect((area as NonNullable<typeof area>).value).toBeCloseTo(112.5, 8)
    expect((area as NonNullable<typeof area>).intervals).toHaveLength(2)
  })
})

describe('NCA log-linear terminal regression', () => {
  it('recovers a known elimination rate from exact exponential data', () => {
    // C = 100·e^(−0.5t): ln C is exactly linear with slope −0.5.
    // Exact values from C = 100·e^(−0.5t), so ln C is exactly linear.
    const concentration = (time: number): number => 100 * Math.exp(-0.5 * time)
    const points = [3, 4, 5].map((time, index) => ({
      time,
      concentration: concentration(time),
      sourceRow: index + 1,
    }))
    const regression = logLinearRegression(points)
    expect(regression).not.toBeNull()
    const fitted = regression as NonNullable<typeof regression>
    expect(fitted.slope).toBeCloseTo(-0.5, 8)
    expect(fitted.lambdaZ).toBeCloseTo(0.5, 8)
    expect(fitted.halfLife).toBeCloseTo(Math.LN2 / 0.5, 8)
    expect(fitted.rSquared).toBeCloseTo(1, 8)
  })

  it('rejects a regression with too few points', () => {
    expect(logLinearRegression([])).toBeNull()
    expect(logLinearRegression([{ time: 0, concentration: 100, sourceRow: 1 }])).toBeNull()
  })

  it('rejects non-positive concentrations in the log regression', () => {
    const result = logLinearRegression(
      rows([
        [0, 100],
        [1, 0],
        [2, 10],
      ]).map((row, index) => ({ time: row.time, concentration: (row as { concentration: number }).concentration, sourceRow: index + 1 })),
    )
    expect(result).toBeNull()
  })
})

describe('NCA main analysis', () => {
  it('computes Cmax and Tmax with the earliest-time tie policy', () => {
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 50],
        [2, 100],
        [3, 25],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    expect(metric(analysis, 'cmax').value).toBe(100)
    expect(metric(analysis, 'cmax').unit).toBe('mg/L')
    // The maximum occurs at t = 0 and t = 2; the earliest is reported.
    expect(metric(analysis, 'tmax').value).toBe(0)
    expect(analysis.warnings.some((warning) => /tied/i.test(warning))).toBe(true)
  })

  it('computes AUC0-last for a decaying dataset and discloses the method', () => {
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 50],
        [2, 25],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    const auc = metric(analysis, 'aucLast')
    expect(auc.name).toBe('AUC(0→last)')
    expect(auc.value).toBeCloseTo(112.5, 8)
    expect(auc.unit).toBe('mg/L·h')
    expect(auc.method).toMatch(/linear trapezoidal/)
    expect(auc.kind).toBe('calculated')
  })

  it('names the area by its interval when it does not start at zero', () => {
    const analysis = analyzeNca(
      rows([
        [1, 50],
        [2, 25],
        [3, 12.5],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    expect(metric(analysis, 'aucLast').name).toBe('AUC(first→last)')
    expect(analysis.warnings.some((warning) => /not labelled AUC0-last|not start at time zero/i.test(warning))).toBe(true)
  })

  it('recovers lambda_z, half-life and AUC0-inf from exact exponential data', () => {
    // C = 100·e^(−0.5t), t = 0..5. AUC0-inf = C0/k = 200.
    const concentration = (time: number): number => 100 * Math.exp(-0.5 * time)
    const data = [0, 1, 2, 3, 4, 5].map((time, index) => ({
      id: `e${index}`,
      sourceRow: index + 1,
      time,
      concentration: concentration(time),
    }))
    const analysis = analyzeNca(data, 'h', 'mg/L', options())
    if (!analysis.ok) throw new Error('expected ok')
    expect(metric(analysis, 'lambdaZ').value).toBeCloseTo(0.5, 8)
    expect(metric(analysis, 'halfLife').value).toBeCloseTo(Math.LN2 / 0.5, 8)
    expect(metric(analysis, 'halfLife').unit).toBe('h')
    // AUC0-last (linear) over 0..5 plus extrapolation C_last/k.
    const aucLast = metric(analysis, 'aucLast').value
    const aucInf = metric(analysis, 'aucInf')
    expect(aucInf.kind).toBe('extrapolated')
    // The linear trapezoid slightly over-estimates a convex decay, so the
    // sampled area is not exactly C0/k; the extrapolation must still satisfy
    // AUCinf = AUClast + C_last/λ_z.
    expect(aucInf.value).toBeCloseTo(aucLast + concentration(5) / 0.5, 3)
    const fraction = metric(analysis, 'extrapolatedFraction')
    expect(fraction.value).toBeCloseTo((concentration(5) / 0.5) / aucInf.value, 8)
    expect(fraction.value).toBeGreaterThan(0)
    expect(fraction.value).toBeLessThan(0.5)
  })

  it('keeps linear-up/log-down consistent with the direction rule', () => {
    // A peak then decline: 10, 40, 20 at 0, 1, 2.
    const analysis = analyzeNca(
      rows([
        [0, 10],
        [1, 40],
        [2, 20],
      ]),
      'h',
      'mg/L',
      options({ integrationMethod: 'linear-up-log-down', terminalPointCount: 3 }),
    )
    if (!analysis.ok) throw new Error('expected ok')
    const auc = metric(analysis, 'aucLast')
    // 0→1 increasing: linear (10+40)/2 = 25. 1→2 decreasing: log (40−20)/ln(2) = 20/0.6931 = 28.85.
    expect(auc.value).toBeCloseTo(25 + 20 / Math.LN2, 4)
    expect(auc.method).toMatch(/linear-up\/log-down/)
  })

  it('makes AUC and the terminal phase unavailable for duplicate times', () => {
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 60],
        [1, 55],
        [2, 30],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    // Cmax/Tmax remain observed facts.
    expect(metric(analysis, 'cmax').value).toBe(100)
    expect(analysis.aucLast.status).toBe('unavailable')
    if (analysis.aucLast.status === 'unavailable') {
      expect(analysis.aucLast.code).toBe('DUPLICATE_SAMPLING_TIMES')
    }
    expect(analysis.terminalPhase.status).toBe('unavailable')
    expect(analysis.warnings.some((warning) => /duplicate sampling time/i.test(warning))).toBe(true)
  })

  it('reports a non-positive terminal slope as unavailable', () => {
    const analysis = analyzeNca(
      rows([
        [0, 10],
        [1, 20],
        [2, 40],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    expect(analysis.lambdaZ.status).toBe('unavailable')
    if (analysis.lambdaZ.status === 'unavailable') {
      expect(analysis.lambdaZ.code).toBe('NON_POSITIVE_TERMINAL_SLOPE')
    }
    expect(analysis.halfLife.status).toBe('unavailable')
  })

  it('reports insufficient terminal points', () => {
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 50],
      ]),
      'h',
      'mg/L',
      options({ terminalPointCount: 3 }),
    )
    if (!analysis.ok) throw new Error('expected ok')
    expect(analysis.terminalPhase.status).toBe('unavailable')
    if (analysis.terminalPhase.status === 'unavailable') {
      expect(analysis.terminalPhase.code).toBe('INSUFFICIENT_TERMINAL_POINTS')
    }
    expect(analysis.terminalPhase.eligiblePositiveCount).toBe(2)
  })

  it('excludes a trailing zero from extrapolation and reports it', () => {
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 50],
        [2, 25],
        [3, 12.5],
        [4, 0],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    // AUC-last still integrates the zero tail (linear).
    expect(metric(analysis, 'aucLast').value).toBeGreaterThan(0)
    // But extrapolation cannot be anchored at a zero last observation.
    expect(analysis.aucInf.status).toBe('unavailable')
    expect(analysis.aucInfInterval).toBeNull()
    if (analysis.aucInf.status === 'unavailable') {
      expect(analysis.aucInf.code).toBe('TERMINAL_TAIL_NOT_POSITIVE')
    }
    expect(analysis.warnings.some((warning) => /non-positive concentration follow the terminal phase/i.test(warning))).toBe(true)
  })

  it('rejects structurally invalid measurements without inventing values', () => {
    const negative = analyzeNca(
      rows([
        [0, 100],
        [1, -5],
      ]),
      'h',
      'mg/L',
      options(),
    )
    expect(negative.ok).toBe(false)
    if (!negative.ok) expect(negative.code).toBe('INVALID_MEASUREMENT')

    const nonFinite = analyzeNca(
      rows([
        [0, Number.POSITIVE_INFINITY],
        [1, 50],
      ]),
      'h',
      'mg/L',
      options(),
    )
    expect(nonFinite.ok).toBe(false)
    if (!nonFinite.ok) expect(nonFinite.code).toBe('INVALID_MEASUREMENT')
  })

  it('is invariant to input ordering and never mutates the input', () => {
    const ordered = rows([
      [0, 100],
      [1, 50],
      [2, 25],
      [3, 12.5],
    ])
    const shuffled = rows([
      [2, 25],
      [0, 100],
      [3, 12.5],
      [1, 50],
    ])
    const snapshot = ordered.map((row) => ({ ...row }))
    const a = analyzeNca(ordered, 'h', 'mg/L', options())
    const b = analyzeNca(shuffled, 'h', 'mg/L', options())
    if (!a.ok || !b.ok) throw new Error('expected ok')
    expect(metric(a, 'aucLast').value).toBeCloseTo(metric(b, 'aucLast').value, 8)
    expect(metric(a, 'lambdaZ').value).toBeCloseTo(metric(b, 'lambdaZ').value, 8)
    expect(ordered).toEqual(snapshot)
  })

  it('rejects an out-of-range terminal point count', () => {
    const result = analyzeNca(
      rows([
        [0, 100],
        [1, 50],
      ]),
      'h',
      'mg/L',
      options({ terminalPointCount: 1 }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe('INSUFFICIENT_TERMINAL_POINTS')
  })

  it('uses only the selected trailing observations for the regression', () => {
    // The last 3 positive observations determine the terminal slope; earlier
    // observations are not part of the regression.
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 70],
        [2, 50],
        [3, 25],
        [4, 12.5],
        [5, 6.25],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    expect(analysis.terminalPhase.status).toBe('available')
    expect(analysis.terminalPhase.selectedSourceRows).toEqual([4, 5, 6])
    // Exact halving from 50 -> 25 -> 12.5 -> 6.25 gives lambda_z = ln 2.
    expect(metric(analysis, 'lambdaZ').value).toBeCloseTo(Math.LN2, 6)
    expect(metric(analysis, 'halfLife').value).toBeCloseTo(1, 6)
  })

  it('reports AUC(0→∞) when the dataset starts at time zero', () => {
    // Exact halving from t = 0: λ_z = ln 2, AUC(0→last) = 112.5, C_last = 25.
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 50],
        [2, 25],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    const aucInf = metric(analysis, 'aucInf')
    expect(aucInf.name).toBe('AUC(0→∞)')
    expect(aucInf.method).toBe('AUC(last) + C_last/λ_z')
    expect(aucInf.value).toBeCloseTo(112.5 + 25 / Math.LN2, 8)
    // The explicit interval discriminant carries the same fact as the name.
    expect(analysis.aucInfInterval).toBe('zero-to-infinity')
    // The fraction is named for the complete curve.
    expect(metric(analysis, 'extrapolatedFraction').method).toBe('(AUC(0→∞) − AUC(0→last)) / AUC(0→∞)')
    expect(metric(analysis, 'extrapolatedFraction').value).toBeCloseTo((25 / Math.LN2) / (112.5 + 25 / Math.LN2), 8)
  })

  it('reports AUC(first→∞), not AUC(0→∞), when the dataset starts after time zero', () => {
    // The same halving curve sampled from t = 1: λ_z = ln 2, AUC(first→last)
    // = 112.5, C_last = 25.
    const analysis = analyzeNca(
      rows([
        [1, 100],
        [2, 50],
        [3, 25],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    expect(metric(analysis, 'aucLast').name).toBe('AUC(first→last)')
    const aucInf = metric(analysis, 'aucInf')
    expect(aucInf.name).toBe('AUC(first→∞)')
    expect(aucInf.name).not.toBe('AUC(0→∞)')
    expect(aucInf.method).toBe('AUC(first→last) + C_last/λ_z')
    expect(aucInf.value).toBeCloseTo(112.5 + 25 / Math.LN2, 8)
    // The discriminant is NOT `zero-to-infinity`, so a dose-dependent consumer
    // can refuse it without parsing the display name.
    expect(analysis.aucInfInterval).toBe('first-to-infinity')
    // The partial-interval disclosure is carried on the metric itself.
    expect(aucInf.notes?.some((note) => /before the first observation is not included/.test(note))).toBe(true)
  })

  it('scopes the extrapolated fraction and warning to the partial interval', () => {
    const analysis = analyzeNca(
      rows([
        [1, 100],
        [2, 50],
        [3, 25],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    const fraction = metric(analysis, 'extrapolatedFraction')
    // Fraction of the partial interval attributable to the extrapolated tail.
    expect(fraction.value).toBeCloseTo((25 / Math.LN2) / (112.5 + 25 / Math.LN2), 8)
    expect(fraction.method).toBe('(AUC(first→∞) − AUC(first→last)) / AUC(first→∞)')
    expect(fraction.notes?.some((note) => /partial-interval/.test(note) && /extrapolated tail/.test(note))).toBe(true)
    // The always-present limitation: the unobserved interval is excluded and
    // the complete-curve criterion is not directly interchangeable.
    expect(
      analysis.warnings.some(
        (warning) => /before the first observation is excluded/.test(warning) && /not directly interchangeable/.test(warning),
      ),
    ).toBe(true)
    // This dataset's fraction exceeds 20%, so the scoped criterion fires and
    // refuses to present the complete-curve rule as interchangeable.
    expect(fraction.value).toBeGreaterThan(0.2)
    expect(
      analysis.warnings.some(
        (warning) => /partial-interval area/.test(warning) && /not directly interchangeable/.test(warning),
      ),
    ).toBe(true)
  })

  it('records only the earliest-time rows for Tmax under a tied Cmax', () => {
    const analysis = analyzeNca(
      rows([
        [0, 100],
        [1, 50],
        [2, 100],
        [3, 25],
      ]),
      'h',
      'mg/L',
      options(),
    )
    if (!analysis.ok) throw new Error('expected ok')
    // Cmax retains every row attaining the maximum.
    expect(metric(analysis, 'cmax').value).toBe(100)
    expect(metric(analysis, 'cmax').contributingSourceRows).toEqual([1, 3])
    // Tmax is the earliest time, and its provenance is only that earliest-time row.
    expect(metric(analysis, 'tmax').value).toBe(0)
    expect(metric(analysis, 'tmax').contributingSourceRows).toEqual([1])
    expect(analysis.warnings.some((warning) => /tied/i.test(warning))).toBe(true)
  })

  it('leaves full-curve NCA behaviour unchanged for exact exponential data', () => {
    // C = 100·e^(−0.5t), t = 0..5. AUC0-inf = C0/k = 200.
    const concentration = (time: number): number => 100 * Math.exp(-0.5 * time)
    const data = [0, 1, 2, 3, 4, 5].map((time, index) => ({
      id: `e${index}`,
      sourceRow: index + 1,
      time,
      concentration: concentration(time),
    }))
    const analysis = analyzeNca(data, 'h', 'mg/L', options())
    if (!analysis.ok) throw new Error('expected ok')
    expect(metric(analysis, 'lambdaZ').value).toBeCloseTo(0.5, 8)
    expect(metric(analysis, 'halfLife').value).toBeCloseTo(Math.LN2 / 0.5, 8)
    const aucInf = metric(analysis, 'aucInf')
    expect(aucInf.name).toBe('AUC(0→∞)')
    expect(aucInf.kind).toBe('extrapolated')
    const aucLast = metric(analysis, 'aucLast').value
    expect(aucInf.value).toBeCloseTo(aucLast + concentration(5) / 0.5, 3)
    const fraction = metric(analysis, 'extrapolatedFraction')
    expect(fraction.value).toBeCloseTo((concentration(5) / 0.5) / aucInf.value, 8)
    expect(fraction.value).toBeGreaterThan(0)
    expect(fraction.value).toBeLessThan(0.5)
  })
})
