import { describe, expect, it } from 'vitest'
import type { ExperimentalMeasurement } from './experimental-dataset'
import { diagnoseMonoExponentialFit } from './mono-exponential-fit-diagnostics'
import { fitMonoExponentialDecay } from './mono-exponential-fit'

function rows(pairs: ReadonlyArray<readonly [number, number]>): ExperimentalMeasurement[] {
  return pairs.map(([time, concentration], index) => ({
    id: 'm' + String(index + 1),
    sourceRow: index + 1,
    time,
    concentration,
  }))
}

function fitted(data: readonly ExperimentalMeasurement[]) {
  const result = fitMonoExponentialDecay(data)
  if (!result.ok) throw new Error('fit failed: ' + result.code + ' ' + result.message)
  return result
}

describe('mono-exponential fit diagnostics (phase 47C)', () => {
  it('computes raw residuals and RMSE without collapsing replicates', () => {
    const data = rows([[0, 100], [0, 102], [1, 51], [2, 24], [4, 6]])
    const diagnostics = diagnoseMonoExponentialFit(data, fitted(data))
    expect(diagnostics.ok).toBe(true)
    if (!diagnostics.ok) return

    expect(diagnostics.measurementCount).toBe(5)
    expect(diagnostics.estimatedParameterCount).toBe(2)
    expect(diagnostics.residualDegreesOfFreedom).toBe(3)
    expect(diagnostics.distinctTimeCount).toBe(4)
    expect(diagnostics.residuals.map((point) => point.sourceRow)).toEqual([1, 2, 3, 4, 5])
    expect(diagnostics.residuals.map((point) => point.time)).toEqual([0, 0, 1, 2, 4])
    expect(diagnostics.residuals[0]?.residual).toBeCloseTo(
      (data[0]?.concentration ?? 0) - (diagnostics.residuals[0]?.fitted ?? 0),
      12,
    )
    const expected = Math.sqrt(
      diagnostics.residuals.reduce((sum, point) => sum + point.residual ** 2, 0) /
        diagnostics.measurementCount,
    )
    expect(diagnostics.rmse).toBeCloseTo(expected, 10)
    expect(diagnostics.rmse).toBeGreaterThan(0)
    expect(diagnostics.dataSupportNotes.join(' ')).toMatch(/not a formal .*identifiability test/i)
  })

  it('flags two distinct time points even if replicates add rows', () => {
    const data = rows([[0, 100], [0, 98], [1, 50], [1, 49]])
    const diagnostics = diagnoseMonoExponentialFit(data, fitted(data))
    expect(diagnostics.ok).toBe(true)
    if (!diagnostics.ok) return
    expect(diagnostics.distinctTimeCount).toBe(2)
    expect(diagnostics.residualDegreesOfFreedom).toBe(2)
    expect(diagnostics.dataSupportNotes.join(' ')).toMatch(/Only 2 distinct time points/)
  })

  it('reports no residual degrees of freedom for a two-row fit', () => {
    const data = rows([[0, 100], [1, 50]])
    const diagnostics = diagnoseMonoExponentialFit(data, fitted(data))
    expect(diagnostics.ok).toBe(true)
    if (!diagnostics.ok) return
    expect(diagnostics.residualDegreesOfFreedom).toBe(0)
    expect(diagnostics.dataSupportNotes.join(' ')).toMatch(/no residual degrees of freedom/i)
  })

  it('returns a structured failure if rows do not match the fitted dataset', () => {
    const data = rows([[0, 100], [1, 50], [2, 25]])
    const result = diagnoseMonoExponentialFit(data.slice(0, 2), fitted(data))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toMatch(/do not match/i)
  })
})
