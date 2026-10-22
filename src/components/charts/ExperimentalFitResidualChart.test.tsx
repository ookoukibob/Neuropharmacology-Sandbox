import { describe, expect, it, vi } from 'vitest'
import type { MonoExponentialResidual } from '@/domain/experiments/mono-exponential-fit-diagnostics'
import { render, screen } from '@testing-library/react'
import { ExperimentalFitResidualChart } from './ExperimentalFitResidualChart'

vi.mock('react-plotly.js', () => ({
  default: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <div data-testid="mock-plot" aria-label={ariaLabel} />
  ),
}))

const residuals: MonoExponentialResidual[] = [
  { measurementId: 'm1', sourceRow: 1, time: 0, observed: 10, fitted: 9.5, residual: 0.5 },
  { measurementId: 'm2', sourceRow: 2, time: 0, observed: 9, fitted: 9.5, residual: -0.5 },
  { measurementId: 'm3', sourceRow: 3, time: 1, observed: 5, fitted: 5, residual: 0 },
]

describe('ExperimentalFitResidualChart', () => {
  it('renders an accessible raw-residual chart container', () => {
    render(
      <ExperimentalFitResidualChart
        residuals={residuals}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Synthetic study"
      />,
    )
    expect(screen.getByTestId('fit-residual-chart')).toBeInTheDocument()
    expect(screen.getByTestId('mock-plot').getAttribute('aria-label')).toMatch(/Residual plot/)
  })

  it('names both axes, the units and the zero line', () => {
    render(
      <ExperimentalFitResidualChart
        residuals={residuals}
        timeUnit="min"
        concentrationUnit="µM"
        datasetName="Synthetic study"
      />,
    )
    const label = screen.getByTestId('mock-plot').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/measured time/i)
    expect(label).toMatch(/min/)
    expect(label).toMatch(/observed minus fitted/i)
    expect(label).toMatch(/µM/)
    expect(label).toMatch(/zero line/i)
    // Markers are not joined into a time course.
    expect(label).toMatch(/no line connects the markers/i)
    expect(label).toMatch(/source row/i)
  })

  it('lets a second instance carry its own name and test id', () => {
    render(
      <ExperimentalFitResidualChart
        residuals={residuals}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Synthetic study"
        modelLabel="Decay with additive baseline"
        testId="fit-residual-chart-m1"
      />,
    )
    expect(screen.getByTestId('fit-residual-chart-m1')).toBeInTheDocument()
    expect(screen.getByTestId('mock-plot').getAttribute('aria-label')).toMatch(
      /Decay with additive baseline/,
    )
  })

  it('renders a single observation safely', () => {
    render(
      <ExperimentalFitResidualChart
        residuals={[residuals[0] as MonoExponentialResidual]}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Single"
      />,
    )
    expect(screen.getByTestId('mock-plot')).toBeInTheDocument()
  })
})
