import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import type {
  AdministrationMetadata,
  ExperimentalMeasurement,
} from '@/domain/experiments/experimental-dataset'
import { NcaCard } from './NcaCard'

const rows = (pairs: readonly (readonly [number, number])[]): ExperimentalMeasurement[] =>
  pairs.map(([time, concentration], index) => ({
    id: `m${index + 1}`,
    sourceRow: index + 1,
    time,
    concentration,
  }))

/** C = 100·e^(−0.5t): λ_z = 0.5 h⁻¹, t½ = ln2/0.5, Cmax = 100, Tmax = 0. */
const decaying = rows([
  [0, 100],
  [1, 60.653],
  [2, 36.788],
  [3, 22.313],
  [4, 13.534],
  [5, 8.208],
])

const ivBolus: AdministrationMetadata = {
  route: 'iv-bolus',
  regimen: 'single-dose',
  timeReference: 'dose-time',
  dose: { value: 100, unit: 'mg' },
}

describe('NcaCard', () => {
  it('shows observed and derived parameters with their units', () => {
    render(
      <NcaCard measurements={decaying} timeUnit="h" concentrationUnit="mg/L" administration={undefined} />,
    )

    expect(screen.getByText(/Noncompartmental analysis/i)).toBeInTheDocument()
    expect(screen.getByTestId('nca-cmax')).toHaveTextContent(/mg\/L/)
    expect(screen.getByTestId('nca-cmax')).toHaveTextContent('100')
    expect(screen.getByTestId('nca-tmax')).toHaveTextContent(/0 h/)
    expect(screen.getByTestId('nca-auc-last')).toHaveTextContent(/mg\/L·h/)
    expect(screen.getByTestId('nca-lambda-z')).toHaveTextContent(/h⁻¹/)
    expect(screen.getByTestId('nca-half-life')).toHaveTextContent(/h/)

    // The terminal phase exposes the regression diagnostics.
    const terminal = screen.getByTestId('nca-terminal')
    expect(terminal).toHaveTextContent(/R²/)
    expect(terminal).toHaveTextContent(/source rows 4, 5, 6/)
  })

  it('labels the area by its interval when it does not start at zero', () => {
    render(
      <NcaCard
        measurements={rows([
          [1, 50],
          [2, 25],
          [3, 12.5],
        ])}
        timeUnit="h"
        concentrationUnit="mg/L"
        administration={undefined}
      />,
    )
    expect(screen.getByTestId('nca-auc-last').closest('tr')).toHaveTextContent('AUC(first→last)')
    expect(screen.getByTestId('nca-warnings')).toHaveTextContent(/not start at time zero/i)
  })

  it('switches the integration method and the terminal point count', () => {
    const { rerender } = render(
      <NcaCard measurements={decaying} timeUnit="h" concentrationUnit="mg/L" administration={undefined} />,
    )
    const linear = screen.getByTestId('nca-auc-last').textContent

    fireEvent.change(screen.getByTestId('nca-integration-method'), {
      target: { value: 'linear-up-log-down' },
    })
    const logDown = screen.getByTestId('nca-auc-last').textContent
    // For a pure decay the two methods differ; the value updates reactively.
    expect(logDown).not.toBe(linear)

    fireEvent.change(screen.getByTestId('nca-terminal-points'), { target: { value: '4' } })
    expect(screen.getByTestId('nca-terminal')).toHaveTextContent(/source rows 3, 4, 5, 6/)

    rerender(
      <NcaCard measurements={decaying} timeUnit="h" concentrationUnit="mg/L" administration={undefined} />,
    )
  })

  it('reports duplicate sampling times without fabricating an AUC', () => {
    render(
      <NcaCard
        measurements={rows([
          [0, 100],
          [1, 60],
          [1, 55],
          [2, 30],
        ])}
        timeUnit="h"
        concentrationUnit="mg/L"
        administration={undefined}
      />,
    )
    expect(screen.getByTestId('nca-auc-last')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('nca-unavailable')).toHaveTextContent(/duplicate sampling time/i)
    // Cmax/Tmax remain observed facts.
    expect(screen.getByTestId('nca-cmax')).toHaveTextContent('100')
    expect(screen.getByTestId('nca-warnings')).toHaveTextContent(/never averaged/i)
  })

  it('reports a non-positive terminal slope as unavailable', () => {
    render(
      <NcaCard
        measurements={rows([
          [0, 10],
          [1, 20],
          [2, 40],
        ])}
        timeUnit="h"
        concentrationUnit="mg/L"
        administration={undefined}
      />,
    )
    expect(screen.getByTestId('nca-lambda-z')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('nca-unavailable')).toHaveTextContent(/do not decline/i)
  })

  it('marks the extrapolated AUC and its fraction as extrapolated/calculated', () => {
    render(
      <NcaCard measurements={decaying} timeUnit="h" concentrationUnit="mg/L" administration={undefined} />,
    )
    const table = screen.getByTestId('nca-table')
    const aucInfRow = screen.getByTestId('nca-auc-inf').closest('tr') as HTMLElement
    expect(aucInfRow).toHaveTextContent('AUC(0→∞)')
    expect(aucInfRow).toHaveTextContent(/extrapolated/)
    const fractionRow = within(table).getByRole('row', { name: /Extrapolated fraction/i })
    expect(fractionRow).toHaveTextContent(/calculated/)
  })

  it('labels the extrapolated AUC by its interval and discloses the partial-interval limitation', () => {
    render(
      <NcaCard
        measurements={rows([
          [1, 100],
          [2, 50],
          [3, 25],
        ])}
        timeUnit="h"
        concentrationUnit="mg/L"
        administration={undefined}
      />,
    )
    // The extrapolated AUC is named for the partial interval, not AUC(0→∞).
    expect(screen.getByTestId('nca-auc-inf').closest('tr')).toHaveTextContent('AUC(first→∞)')
    expect(screen.getByTestId('nca-auc-inf').closest('tr')).not.toHaveTextContent('AUC(0→∞)')
    // An explicit limitation is shown and the warning is scoped to the partial interval.
    expect(screen.getByTestId('nca-interval-limitation')).toHaveTextContent(/not included/i)
    expect(screen.getByTestId('nca-interval-limitation')).toHaveTextContent(/not directly interchangeable/i)
    expect(screen.getByTestId('nca-warnings')).toHaveTextContent(/before the first observation is excluded/i)
  })

  it('shows an explicit unavailable reason when no administration metadata is recorded', () => {
    render(
      <NcaCard measurements={decaying} timeUnit="h" concentrationUnit="mg/L" administration={undefined} />,
    )
    expect(screen.getByTestId('dose-dependent-nca')).toBeInTheDocument()
    expect(screen.getByTestId('dose-dependent-cl')).toHaveTextContent('—')
    expect(screen.getByTestId('dose-dependent-cl-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('dose-dependent-unavailable')).toHaveTextContent(/ADMINISTRATION_MISSING/)
  })

  it('shows absolute CL and Vz for an IV bolus and marks the apparent twins not applicable', () => {
    render(
      <NcaCard measurements={decaying} timeUnit="h" concentrationUnit="mg/L" administration={ivBolus} />,
    )
    expect(screen.getByTestId('dose-dependent-cl')).toHaveTextContent(/L\/h/)
    expect(screen.getByTestId('dose-dependent-cl-status')).toHaveTextContent('available')
    expect(screen.getByTestId('dose-dependent-vz')).toHaveTextContent(/ L$/)
    expect(screen.getByTestId('dose-dependent-cl-f-status')).toHaveTextContent('not applicable')
    expect(screen.getByTestId('dose-dependent-vz-f-status')).toHaveTextContent('not applicable')
    // The audit block shows the dose and the AUC interval actually used.
    const inputs = screen.getByTestId('dose-dependent-inputs')
    expect(inputs).toHaveTextContent('100 mg')
    expect(inputs).toHaveTextContent(/AUC\(0→∞\)/)
    expect(inputs).toHaveTextContent(/1 by the IV route definition/)
  })

  it('reports only the apparent parameters for an extravascular dose without F', () => {
    render(
      <NcaCard
        measurements={decaying}
        timeUnit="h"
        concentrationUnit="mg/L"
        administration={{
          route: 'extravascular',
          regimen: 'single-dose',
          timeReference: 'dose-time',
          dose: { value: 100, unit: 'mg' },
        }}
      />,
    )
    expect(screen.getByTestId('dose-dependent-cl-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('dose-dependent-unavailable')).toHaveTextContent(/BIOAVAILABILITY_MISSING/)
    expect(screen.getByTestId('dose-dependent-cl-f-status')).toHaveTextContent('available')
    expect(screen.getByTestId('dose-dependent-vz-f-status')).toHaveTextContent('conditional')
    expect(screen.getByTestId('dose-dependent-conditional')).toHaveTextContent(/flip-flop/i)
  })

  it('refuses a partial interval even when administration metadata is complete', () => {
    render(
      <NcaCard
        measurements={rows([
          [1, 100],
          [2, 50],
          [3, 25],
        ])}
        timeUnit="h"
        concentrationUnit="mg/L"
        administration={ivBolus}
      />,
    )
    expect(screen.getByTestId('dose-dependent-cl-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('dose-dependent-unavailable')).toHaveTextContent(/AUC_NOT_COMPLETE/)
  })
})
