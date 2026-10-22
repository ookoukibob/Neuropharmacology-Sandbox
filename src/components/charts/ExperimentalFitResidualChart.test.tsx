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
    expect(screen.getByTestId('mock-plot')).toHaveAttribute('aria-label', /Residual plot/)
  })
})
