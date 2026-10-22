import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { MonoExponentialProfilePoint } from '@/domain/experiments/mono-exponential-profile'
import { ExperimentalFitProfileChart } from './ExperimentalFitProfileChart'

vi.mock('react-plotly.js', () => ({
  default: ({ 'aria-label': ariaLabel }: { 'aria-label'?: string }) => (
    <div data-testid="mock-plot" aria-label={ariaLabel} />
  ),
}))

const points: MonoExponentialProfilePoint[] = [
  { ok: true, q: 0, k: 0, sse: 1000 },
  { ok: true, q: 0.5, k: 0.125, sse: 40 },
  { ok: true, q: 1, k: 0.25, sse: 4 },
  { ok: true, q: 1.5, k: 0.375, sse: 60 },
]

describe('ExperimentalFitProfileChart', () => {
  it('labels the plotted quantity as a residual sum of squares with both axes and units', () => {
    render(
      <ExperimentalFitProfileChart
        points={points}
        fittedRate={0.25}
        fittedSse={4}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Synthetic study"
      />,
    )
    expect(screen.getByTestId('fit-profile-chart')).toBeInTheDocument()
    const label = screen.getByTestId('mock-plot').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/residual sum of squares/i)
    // Both axes, both units, and the amplitude projection are named.
    expect(label).toMatch(/decay rate k/i)
    expect(label).toMatch(/reciprocal h/i)
    expect(label).toMatch(/mg\/L/)
    expect(label).toMatch(/amplitude re-solved/i)
    // Correctly identified: an objective profile, explicitly not a likelihood.
    expect(label).toMatch(/not a likelihood or profile likelihood/i)
  })

  it('does not claim a confidence region or a likelihood profile', () => {
    render(
      <ExperimentalFitProfileChart
        points={points}
        fittedRate={0.25}
        fittedSse={4}
        timeUnit="min"
        concentrationUnit="µM"
        datasetName="Synthetic study"
      />,
    )
    const label = screen.getByTestId('mock-plot').getAttribute('aria-label') ?? ''
    expect(label).toMatch(/not a confidence interval/i)
    expect(label).not.toMatch(/confidence level of/i)
  })

  it('renders a single evaluated candidate safely', () => {
    render(
      <ExperimentalFitProfileChart
        points={[{ ok: true, q: 0, k: 0, sse: 12 }]}
        fittedRate={0}
        fittedSse={12}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="One point"
      />,
    )
    expect(screen.getByTestId('mock-plot')).toBeInTheDocument()
  })

  it('skips candidates that could not be evaluated instead of interpolating them', () => {
    render(
      <ExperimentalFitProfileChart
        points={[
          { ok: true, q: 0, k: 0, sse: 12 },
          { ok: false, q: 1, k: null, reason: 'NON_FINITE_RATE' },
          { ok: false, q: 2, k: 0.5, reason: 'NON_FINITE_OBJECTIVE' },
        ]}
        fittedRate={0}
        fittedSse={12}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Partial"
      />,
    )
    expect(screen.getByTestId('mock-plot')).toBeInTheDocument()
  })

  it('renders an explicit empty state when nothing could be evaluated', () => {
    render(
      <ExperimentalFitProfileChart
        points={[{ ok: false, q: 1, k: null, reason: 'NON_FINITE_RATE' }]}
        fittedRate={0}
        fittedSse={0}
        timeUnit="h"
        concentrationUnit="mg/L"
        datasetName="Empty"
      />,
    )
    expect(screen.queryByTestId('mock-plot')).not.toBeInTheDocument()
    expect(screen.getByTestId('fit-profile-chart')).toHaveTextContent(/cannot be drawn/i)
  })
})
