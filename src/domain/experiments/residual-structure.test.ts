import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import { fitMonoExponentialDecay } from './mono-exponential-fit'
import { fitMonoExponentialWithBaseline } from './mono-exponential-baseline-fit'
import type { MonoExponentialResidual } from './mono-exponential-fit-diagnostics'
import {
  SPREAD_RATIO_HEURISTIC,
  SPREAD_SCREEN_MIN_OBSERVATIONS,
  analyzeBaselineResiduals,
  analyzeMonoExponentialResiduals,
  screenResidualSpread,
} from './residual-structure'

/**
 * Residual structure diagnostics.
 *
 * All fixtures are SYNTHETIC and generated from explicit arithmetic, so every
 * expected residual can be recomputed in the test itself. Nothing here is
 * pharmacological information.
 */

let counter = 0
const rows = (pairs: ReadonlyArray<readonly [number, number]>): ExperimentalMeasurement[] => {
  counter = 0
  return pairs.map(([time, concentration]) => {
    counter += 1
    return { id: `m${counter}`, sourceRow: counter, time, concentration }
  })
}

const synth = (cRef: number, k: number, times: readonly number[], tRef = 0): ExperimentalMeasurement[] =>
  rows(times.map((time) => [time, cRef * Math.exp(-k * (time - tRef))] as const))

const monoFit = (data: readonly ExperimentalMeasurement[]) => {
  const result = fitMonoExponentialDecay(data)
  if (!result.ok) throw new Error('M0 failed: ' + result.code + ' ' + result.message)
  return result
}

const baselineFit = (data: readonly ExperimentalMeasurement[]) => {
  const result = fitMonoExponentialWithBaseline(data)
  if (!result.ok) throw new Error('M1 failed: ' + result.code + ' ' + result.message)
  return result
}

describe('residuals are the fit’s own residuals', () => {
  it('M0 residuals match observed minus the model equation', () => {
    const data = synth(100, 0.4, [0, 1, 2, 3, 4, 5])
    const fit = monoFit(data)
    const structure = analyzeMonoExponentialResiduals(data, fit)
    expect(structure.ok).toBe(true)
    if (!structure.ok) return

    expect(structure.modelId).toBe('M0')
    expect(structure.measurementCount).toBe(6)
    expect(structure.residuals).toHaveLength(6)
    expect(structure.residuals.map((point) => point.sourceRow)).toEqual([1, 2, 3, 4, 5, 6])

    for (const [index, point] of structure.residuals.entries()) {
      const measurement = data[index]
      if (measurement === undefined) throw new Error('setup')
      const expectedFitted = fit.cRef * Math.exp(-fit.k * (measurement.time - fit.tRef))
      expect(point.fitted).toBeCloseTo(expectedFitted, 10)
      expect(point.residual).toBeCloseTo((measurement as { concentration: number }).concentration - expectedFitted, 10)
      expect(point.observed).toBe((measurement as { concentration: number }).concentration)
    }
    // Reused from the existing diagnostics: identical RMSE.
    expect(structure.rmse).toBeGreaterThanOrEqual(0)
  })

  it('M1 residuals match the baseline equation and reuse the published fit', () => {
    const data = rows([
      [0, 100],
      [0.5, 83.6],
      [1, 70.3],
      [2, 50.4],
      [3, 37.1],
      [5, 22.2],
    ])
    const fit = baselineFit(data)
    const structure = analyzeBaselineResiduals(data, fit)
    expect(structure.ok).toBe(true)
    if (!structure.ok) return

    expect(structure.modelId).toBe('M1')
    for (const [index, point] of structure.residuals.entries()) {
      const measurement = data[index]
      if (measurement === undefined) throw new Error('setup')
      const expectedFitted =
        fit.baseline + fit.amplitude * Math.exp(-fit.k * (measurement.time - fit.tRef))
      expect(point.fitted).toBeCloseTo(expectedFitted, 10)
      expect(point.residual).toBeCloseTo((measurement as { concentration: number }).concentration - expectedFitted, 10)
    }
  })

  it('keeps duplicate timestamps and replicates as separate residuals', () => {
    const data = rows([
      [0, 100],
      [0, 98],
      [1, 62],
      [1, 60],
      [2, 40],
      [2, 39],
    ])
    const structure = analyzeMonoExponentialResiduals(data, monoFit(data))
    if (!structure.ok) throw new Error('expected structure')

    expect(structure.residuals).toHaveLength(6)
    expect(structure.timeOrder.distinctTimeCount).toBe(3)
    expect(structure.timeOrder.duplicateTimeRowCount).toBe(6)
    // The two rows at t = 0 keep different observed values.
    const atZero = structure.residuals.filter((point) => point.time === 0)
    expect(atZero).toHaveLength(2)
    expect(atZero[0]?.observed).not.toBe(atZero[1]?.observed)
    expect(structure.timeOrder.notes.join(' ')).toMatch(/sharing a timestamp/i)
  })

  it('discloses that stored order is not time order', () => {
    const ordered = rows([
      [0, 100],
      [1, 60],
      [2, 36],
      [3, 22],
      [4, 13],
      [5, 8],
    ])
    const shuffled = rows([
      [2, 36],
      [0, 100],
      [4, 13],
      [1, 60],
      [5, 8],
      [3, 22],
    ])

    const orderedStructure = analyzeMonoExponentialResiduals(ordered, monoFit(ordered))
    const shuffledStructure = analyzeMonoExponentialResiduals(shuffled, monoFit(shuffled))
    if (!orderedStructure.ok || !shuffledStructure.ok) throw new Error('expected structure')

    expect(orderedStructure.timeOrder.sourceOrderFollowsTime).toBe(true)
    expect(shuffledStructure.timeOrder.sourceOrderFollowsTime).toBe(false)
    expect(shuffledStructure.timeOrder.notes.join(' ')).toMatch(/not in increasing time order/i)
    // Reshuffling does not change the fit: the same estimate and the same
    // residual magnitude, to numerical resolution.
    expect(shuffledStructure.rmse).toBeCloseTo(orderedStructure.rmse, 9)
    expect(shuffledStructure.spread.ok).toBe(orderedStructure.spread.ok)
  })
})

describe('residual spread screen', () => {
  it('reports a visible pattern when absolute residuals grow with the fitted level', () => {
    // Proportional scatter: the residual amplitude follows the fitted
    // concentration, which is the pattern this screen is meant to surface.
    const base = [100, 67.03, 44.93, 30.12, 20.19, 13.53]
    const signs = [1, -1, 1, -1, 1, -1]
    const data = rows(
      base.map((value, index) => [index, value * (1 + 0.1 * (signs[index] ?? 1))] as const),
    )
    const structure = analyzeMonoExponentialResiduals(data, monoFit(data))
    if (!structure.ok) throw new Error('expected structure')
    const spread = structure.spread
    expect(spread.ok).toBe(true)
    if (!spread.ok) return
    expect(spread.status).toBe('visible-pattern')
    expect(spread.ratio).not.toBeNull()
    expect(spread.ratio as number).toBeGreaterThanOrEqual(SPREAD_RATIO_HEURISTIC)
    expect(spread.message).toMatch(/not a test result/i)
  })

  it('reports no visible pattern for an evenly scattered synthetic case', () => {
    // Same curve, alternating residuals of equal magnitude across the range.
    const base = [100, 60.65, 36.79, 22.31, 13.53, 8.21]
    const offsets = [2, -2, 2, -2, 2, -2]
    const data = rows(
      base.map((value, index) => [index, value + (offsets[index] ?? 0)] as const),
    )
    const structure = analyzeMonoExponentialResiduals(data, monoFit(data))
    if (!structure.ok) throw new Error('expected structure')
    const spread = structure.spread
    expect(spread.ok).toBe(true)
    if (!spread.ok) return
    expect(spread.status).toBe('no-visible-pattern')
    expect(spread.ratio).not.toBeNull()
    expect(spread.ratio as number).toBeLessThan(SPREAD_RATIO_HEURISTIC)
    // The wording must not claim that variance is constant.
    expect(spread.message).toMatch(/not evidence that the spread is constant/i)
  })

  it('discloses an overlap when a fitted value straddles the count-based cut', () => {
    // Six observations over four distinct fitted values: a count-based split
    // lands inside the group fitted at 20, so both halves contain it.
    const residuals: MonoExponentialResidual[] = [
      { measurementId: 'a', sourceRow: 1, time: 0, observed: 10, fitted: 10, residual: 1 },
      { measurementId: 'b', sourceRow: 2, time: 0, observed: 10, fitted: 10, residual: -1 },
      { measurementId: 'c', sourceRow: 3, time: 1, observed: 20, fitted: 20, residual: 3 },
      { measurementId: 'd', sourceRow: 4, time: 1, observed: 20, fitted: 20, residual: -3 },
      { measurementId: 'e', sourceRow: 5, time: 2, observed: 20, fitted: 20, residual: 1 },
      { measurementId: 'f', sourceRow: 6, time: 2, observed: 20, fitted: 20, residual: -1 },
    ]
    const spread = screenResidualSpread(residuals)
    expect(spread.ok).toBe(true)
    if (!spread.ok) return

    expect(spread.boundaryTies).toBe(true)
    expect(spread.splitFittedValue).toBe(20)
    expect(spread.upperFirstFittedValue).toBe(20)
    expect(spread.splitDisclosure).toMatch(/overlap at the split/i)
    expect(spread.splitDisclosure).toMatch(/both contain observations fitted at the same value/i)
    expect(spread.splitDisclosure).toMatch(/count-based/i)
    expect(spread.splitDisclosure).toMatch(/not two strictly separated/i)
  })

  it('reports a separated split when no fitted value straddles the cut', () => {
    const residuals: MonoExponentialResidual[] = [
      { measurementId: 'a', sourceRow: 1, time: 0, observed: 10, fitted: 10, residual: 1 },
      { measurementId: 'b', sourceRow: 2, time: 1, observed: 20, fitted: 20, residual: -1 },
      { measurementId: 'c', sourceRow: 3, time: 2, observed: 30, fitted: 30, residual: 1 },
      { measurementId: 'd', sourceRow: 4, time: 3, observed: 40, fitted: 40, residual: -1 },
      { measurementId: 'e', sourceRow: 5, time: 4, observed: 50, fitted: 50, residual: 1 },
      { measurementId: 'f', sourceRow: 6, time: 5, observed: 60, fitted: 60, residual: -1 },
    ]
    const spread = screenResidualSpread(residuals)
    expect(spread.ok).toBe(true)
    if (!spread.ok) return

    expect(spread.boundaryTies).toBe(false)
    expect(spread.splitFittedValue).toBe(30)
    expect(spread.upperFirstFittedValue).toBe(40)
    expect(spread.splitDisclosure).toMatch(/separated/i)
    expect(spread.splitDisclosure).not.toMatch(/overlap/i)
  })

  it('does not reorder the caller’s residuals when splitting', () => {
    const residuals: MonoExponentialResidual[] = [
      { measurementId: 'a', sourceRow: 1, time: 0, observed: 10, fitted: 50, residual: 1 },
      { measurementId: 'b', sourceRow: 2, time: 1, observed: 20, fitted: 10, residual: -1 },
      { measurementId: 'c', sourceRow: 3, time: 2, observed: 30, fitted: 40, residual: 1 },
      { measurementId: 'd', sourceRow: 4, time: 3, observed: 40, fitted: 20, residual: -1 },
      { measurementId: 'e', sourceRow: 5, time: 4, observed: 50, fitted: 60, residual: 1 },
      { measurementId: 'f', sourceRow: 6, time: 5, observed: 60, fitted: 30, residual: -1 },
    ]
    const order = residuals.map((point) => point.sourceRow)
    screenResidualSpread(residuals)
    expect(residuals.map((point) => point.sourceRow)).toEqual(order)
  })

  it('reports inconclusive when every residual is exactly zero', () => {
    const residuals: MonoExponentialResidual[] = [
      { measurementId: 'a', sourceRow: 1, time: 0, observed: 100, fitted: 100, residual: 0 },
      { measurementId: 'b', sourceRow: 2, time: 1, observed: 60, fitted: 60, residual: 0 },
      { measurementId: 'c', sourceRow: 3, time: 2, observed: 36, fitted: 36, residual: 0 },
      { measurementId: 'd', sourceRow: 4, time: 3, observed: 22, fitted: 22, residual: 0 },
      { measurementId: 'e', sourceRow: 5, time: 4, observed: 13, fitted: 13, residual: 0 },
      { measurementId: 'f', sourceRow: 6, time: 5, observed: 8, fitted: 8, residual: 0 },
    ]
    const spread = screenResidualSpread(residuals)
    expect(spread.ok).toBe(true)
    if (!spread.ok) return
    expect(spread.status).toBe('inconclusive')
    expect(spread.message).toMatch(/every residual is zero/i)
  })

  it('is unavailable below the documented observation floor', () => {
    const data = rows([
      [0, 100],
      [1, 60],
      [2, 36],
      [3, 22],
      [4, 13],
    ])
    expect(SPREAD_SCREEN_MIN_OBSERVATIONS).toBe(6)
    const structure = analyzeMonoExponentialResiduals(data, monoFit(data))
    if (!structure.ok) throw new Error('expected structure')
    expect(structure.spread.ok).toBe(false)
    if (structure.spread.ok) return
    expect(structure.spread.code).toBe('INSUFFICIENT_OBSERVATIONS')
    expect(structure.spread.message).toMatch(/at least 6 observations/i)
    // The residuals themselves are still available.
    expect(structure.residuals).toHaveLength(5)
  })

  it('is unavailable when the fitted values cannot be split', () => {
    const data = rows([
      [0, 50],
      [1, 50],
      [2, 50],
      [3, 50],
      [4, 50],
      [5, 50],
    ])
    const structure = analyzeMonoExponentialResiduals(data, monoFit(data))
    if (!structure.ok) throw new Error('expected structure')
    expect(structure.spread.ok).toBe(false)
    if (structure.spread.ok) return
    expect(['DEGENERATE_FIT', 'INSUFFICIENT_OBSERVATIONS']).toContain(structure.spread.code)
  })
})

describe('unavailable diagnostics', () => {
  it('rejects rows that do not match the fitted dataset', () => {
    const data = synth(100, 0.4, [0, 1, 2, 3, 4, 5])
    const fit = monoFit(data)
    const structure = analyzeMonoExponentialResiduals(data.slice(0, 4), fit)
    expect(structure.ok).toBe(false)
    if (structure.ok) return
    expect(structure.code).toBe('MEASUREMENT_MISMATCH')
  })

  it('reports a failed baseline fit as unavailable rather than deriving residuals', () => {
    const data = synth(100, 0.4, [0, 1, 2, 3, 4, 5])
    const structure = analyzeBaselineResiduals(data, {
      ok: false,
      code: 'NON_CONVERGED',
      message: 'The rate optimizer did not converge to a finite value.',
    })
    expect(structure.ok).toBe(false)
    if (structure.ok) return
    expect(structure.code).toBe('FIT_UNAVAILABLE')
    expect(structure.message).toMatch(/did not converge/i)
  })
})

describe('data integrity', () => {
  it('never mutates the measurements and is deterministic', () => {
    const data = synth(80, 0.55, [0, 0.5, 1, 2, 3, 5])
    const snapshot = data.map((measurement) => ({ ...measurement }))
    data.forEach((measurement) => Object.freeze(measurement))
    Object.freeze(data)

    const first = analyzeMonoExponentialResiduals(data, monoFit(data))
    const second = analyzeMonoExponentialResiduals(data, monoFit(data))
    expect(first).toEqual(second)
    expect(data).toEqual(snapshot)
  })

  it('states the standing limitations', () => {
    const data = synth(100, 0.4, [0, 1, 2, 3, 4, 5])
    const structure = analyzeMonoExponentialResiduals(data, monoFit(data))
    if (!structure.ok) throw new Error('expected structure')
    const text = structure.notes.join(' ')
    expect(text).toMatch(/observed concentration minus fitted concentration/i)
    expect(text).toMatch(/does not establish it/i)
    expect(text).toMatch(/no autocorrelation, independence test/i)
  })
})
