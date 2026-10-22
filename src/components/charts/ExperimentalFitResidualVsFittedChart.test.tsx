import { describe, expect, it, vi } from 'vitest'
import type { MonoExponentialResidual } from '@/domain/experiments/mono-exponential-fit-diagnostics'
import { render, screen } from '@testing-library/react'
import { ExperimentalFitResidualVsFittedChart } from './ExperimentalFitResidualVsFittedChart'

// The hover content is user-facing output, so the stub exposes the trace's
// text array verbatim instead of hiding it behind chart internals.
vi.mock('react-plotly.js', () => ({
  default: ({
    'aria-label': ariaLabel,
    data,
  }: {
    'aria-label'?: string
    data?: readonly { text?: readonly string[] }[]
  }) => (
    <div
      data-testid="mock-plot"
      aria-label={ariaLabel}
      data-hover={(data?.[0]?.text ?? []).join(' | ')}
    />
  ),
}))

const residuals: MonoExponentialResidual[] = [
  { measurementId: 'm1', sourceRow: 1, time: 0, observed: 10, fitted: 9.5, residual: 0.5 },
  { measurementId: 'm2', sourceRow: 2, time: 0, observed: 9, fitted: 9.5, residual: -0.5 },
  { measurementId: 'm3', sourceRow: 3, time: 1, observed: 5, fitted: 5, residual: 0 },
]

describe('ExperimentalFitResidualVsFittedChart', () => {
  it('labels both axes with the concentration unit and the zero line', () => {
    render(
      <ExperimentalFitResidualVsFittedChart
        residuals={residuals}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Synthetic study"
      />,
    )
    expect(screen.getByTestId('fit-residual-fitted-chart')).toBeInTheDocument()
    const label = screen.getByTestId('mock-plot').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/fitted concentration/i)
    expect(label).toMatch(/mg\/L/)
    expect(label).toMatch(/observed minus fitted/i)
    expect(label).toMatch(/zero line/i)
    // The wording must not present the view as a test.
    expect(label).toMatch(/not a test of constant variance/i)
    expect(label).toMatch(/source row/i)
  })

  it('includes the observed concentration and its unit in every point', () => {
    const withDistinctObserved: MonoExponentialResidual[] = [
      { measurementId: 'a', sourceRow: 7, time: 2, observed: 4.2, fitted: 3.9, residual: 0.3 },
      { measurementId: 'b', sourceRow: 8, time: 3, observed: 2.1, fitted: 2.4, residual: -0.3 },
    ]
    render(
      <ExperimentalFitResidualVsFittedChart
        residuals={withDistinctObserved}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Synthetic study"
      />,
    )
    const hover = screen.getByTestId('mock-plot').getAttribute('data-hover') ?? ''
    // Every point carries the full identity: row, time, observed, fitted, residual.
    expect(hover).toMatch(/Source row: 7/)
    expect(hover).toMatch(/Measured time: 2 h/)
    expect(hover).toMatch(/Observed: 4\.2 mg\/L/)
    expect(hover).toMatch(/Fitted: 3\.9 mg\/L/)
    expect(hover).toMatch(/Residual \(observed − fitted\): 0\.3 mg\/L/)
    // The second point keeps its own observed value; the array is not shared.
    expect(hover).toMatch(/Source row: 8/)
    expect(hover).toMatch(/Observed: 2\.1 mg\/L/)
  })

  it('keeps a model label and a custom test id for a second instance', () => {
    render(
      <ExperimentalFitResidualVsFittedChart
        residuals={residuals}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Synthetic study"
        modelLabel="Decay model"
        testId="residual-fitted-chart-m0"
      />,
    )
    expect(screen.getByTestId('residual-fitted-chart-m0')).toBeInTheDocument()
    expect(screen.getByTestId('mock-plot').getAttribute('aria-label')).toMatch(/Decay model/)
  })

  it('renders safely with no residuals', () => {
    render(
      <ExperimentalFitResidualVsFittedChart
        residuals={[]}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Empty"
      />,
    )
    expect(screen.getByTestId('mock-plot')).toBeInTheDocument()
  })
})
