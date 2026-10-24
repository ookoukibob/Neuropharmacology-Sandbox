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

/** C = 100 − 5t over one 12 h interval: AUCτ = (100 + 40)/2 · 12 = 840. */
const intervalRows = rows([
  [0, 100],
  [2, 90],
  [4, 80],
  [6, 70],
  [8, 60],
  [10, 50],
  [12, 40],
])

const steadyState: AdministrationMetadata = {
  route: 'iv-bolus',
  regimen: 'repeated-dose-steady-state',
  timeReference: 'dose-time',
  dose: { value: 84, unit: 'mg' },
  doseBasis: 'per-administration',
  dosingInterval: { value: 12, unit: 'h' },
}

function renderRepeated(administration: AdministrationMetadata = steadyState) {
  render(
    <NcaCard
      measurements={intervalRows}
      timeUnit="h"
      concentrationUnit="mg/L"
      administration={administration}
    />,
  )
}

describe('NcaCard repeated-dose interval AUCτ', () => {
  it('offers the observed times and refuses to guess an interval', () => {
    renderRepeated()
    expect(screen.getByTestId('repeated-dose-nca')).toBeInTheDocument()
    expect(screen.getByTestId('repeated-dose-tau')).toHaveTextContent('12 h')
    // Nothing is pre-selected: the selectors start empty.
    expect(screen.getByTestId('repeated-interval-start')).toHaveValue('')
    expect(screen.getByTestId('repeated-interval-end')).toHaveValue('')
    expect(screen.getByTestId('interval-auc-unavailable')).toHaveTextContent(/INTERVAL_NOT_SELECTED/)
    expect(screen.getByTestId('steady-state-cl-status')).toHaveTextContent('unavailable')
  })

  it('computes AUCτ for the interval the analyst selects', () => {
    renderRepeated()
    fireEvent.change(screen.getByTestId('repeated-interval-start'), { target: { value: '0' } })
    fireEvent.change(screen.getByTestId('repeated-interval-end'), { target: { value: '12' } })

    const block = screen.getByTestId('interval-auc')
    expect(block).toHaveTextContent('840')
    expect(block).toHaveTextContent('mg/L·h')
    expect(block).toHaveTextContent(/Contributing source rows1, 2, 3, 4, 5, 6, 7/)
    // Without the alignment confirmation the steady-state parameters stay refused.
    expect(screen.getByTestId('steady-state-cl-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('steady-state-unavailable')).toHaveTextContent(/INTERVAL_NOT_ALIGNED/)
  })

  it('derives CL once the interval is confirmed to start at a dose', () => {
    renderRepeated()
    fireEvent.change(screen.getByTestId('repeated-interval-start'), { target: { value: '0' } })
    fireEvent.change(screen.getByTestId('repeated-interval-end'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('interval-aligned'))

    expect(screen.getByTestId('steady-state-cl-status')).toHaveTextContent('available')
    // 84 mg / 840 mg·L⁻¹·h = 0.1 L/h.
    expect(screen.getByTestId('steady-state-cl')).toHaveTextContent('0.1')
    expect(screen.getByTestId('steady-state-cl')).toHaveTextContent('L/h')
    expect(screen.getByTestId('steady-state-cl-f-status')).toHaveTextContent('not applicable')
    expect(screen.getByTestId('steady-state-inputs')).toHaveTextContent('per-administration')
    expect(screen.getByTestId('steady-state-inputs')).toHaveTextContent('840')
  })

  it('reports a length mismatch instead of accepting an arbitrary window', () => {
    renderRepeated()
    fireEvent.change(screen.getByTestId('repeated-interval-start'), { target: { value: '0' } })
    fireEvent.change(screen.getByTestId('repeated-interval-end'), { target: { value: '8' } })
    expect(screen.getByTestId('interval-auc-unavailable')).toHaveTextContent(/INTERVAL_LENGTH_MISMATCH/)
    expect(screen.getByTestId('interval-auc-unavailable')).toHaveTextContent(/not one τ wide/i)
  })

  it('keeps AUCτ but refuses dose-dependent parameters for repeated dosing off steady state', () => {
    renderRepeated({ ...steadyState, regimen: 'repeated-dose' })
    expect(screen.getByTestId('steady-state-declaration-missing')).toBeInTheDocument()
    expect(screen.getByTestId('steady-state-declaration-missing')).toHaveTextContent(/not a clearance/i)

    fireEvent.change(screen.getByTestId('repeated-interval-start'), { target: { value: '0' } })
    fireEvent.change(screen.getByTestId('repeated-interval-end'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('interval-aligned'))

    // The interval area is reported...
    expect(screen.getByTestId('interval-auc')).toHaveTextContent('840')
    // ...but no clearance is published from a non-steady-state interval.
    expect(screen.getByTestId('steady-state-cl-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('steady-state-unavailable')).toHaveTextContent(/REGIMEN_NOT_STEADY_STATE/)
  })

  it('does not offer an interval analysis for a single dose', () => {
    render(
      <NcaCard measurements={intervalRows} timeUnit="h" concentrationUnit="mg/L" administration={ivBolus} />,
    )
    expect(screen.queryByTestId('repeated-dose-nca')).not.toBeInTheDocument()
  })

  it('clears the interval selection completely', () => {
    renderRepeated()
    fireEvent.change(screen.getByTestId('repeated-interval-start'), { target: { value: '0' } })
    fireEvent.change(screen.getByTestId('repeated-interval-end'), { target: { value: '12' } })
    fireEvent.click(screen.getByTestId('interval-aligned'))
    expect(screen.getByTestId('steady-state-cl-status')).toHaveTextContent('available')

    fireEvent.click(screen.getByTestId('interval-clear'))
    expect(screen.getByTestId('repeated-interval-start')).toHaveValue('')
    expect(screen.getByTestId('repeated-interval-end')).toHaveValue('')
    expect(screen.getByTestId('interval-aligned')).not.toBeChecked()
    expect(screen.getByTestId('interval-auc-unavailable')).toHaveTextContent(/INTERVAL_NOT_SELECTED/)
  })
})

describe('NcaCard interval exposure summary', () => {
  function selectInterval(start = '0', end = '12', align = true) {
    fireEvent.change(screen.getByTestId('repeated-interval-start'), { target: { value: start } })
    fireEvent.change(screen.getByTestId('repeated-interval-end'), { target: { value: end } })
    if (align) fireEvent.click(screen.getByTestId('interval-aligned'))
  }

  it('reports the observed peak, trough and means for a steady-state interval', () => {
    renderRepeated()
    selectInterval()

    expect(screen.getByTestId('exposure-summary')).toBeInTheDocument()
    expect(screen.getByTestId('exposure-cmax-obs')).toHaveTextContent('100 mg/L')
    expect(screen.getByTestId('exposure-tmax-obs')).toHaveTextContent('0 h')
    expect(screen.getByTestId('exposure-cmin-obs')).toHaveTextContent('40 mg/L')
    expect(screen.getByTestId('exposure-tmin-obs')).toHaveTextContent('12 h')
    // 840 mg/L·h ÷ 12 h = 70 mg/L for both interval and steady-state means.
    expect(screen.getByTestId('exposure-cavg-interval')).toHaveTextContent('70 mg/L')
    expect(screen.getByTestId('exposure-cavg-ss')).toHaveTextContent('70 mg/L')
    expect(screen.getByTestId('exposure-cavg-ss-status')).toHaveTextContent('available')
    // 100 · (100 − 40) / 70 = 85.714… %.
    expect(screen.getByTestId('exposure-fluctuation')).toHaveTextContent('85.714')
    expect(screen.getByTestId('exposure-fluctuation')).toHaveTextContent('%')

    // The attaining observations name the source row, and the observed kind is explicit.
    expect(screen.getAllByTestId('exposure-peak-observations-item')).toHaveLength(1)
    expect(screen.getByTestId('exposure-peak-observations-item')).toHaveTextContent(/source row 1$/)
    expect(screen.getAllByTestId('exposure-trough-observations-item')).toHaveLength(1)
    expect(screen.getByTestId('exposure-trough-observations-item')).toHaveTextContent(/source row 7$/)
    expect(screen.getAllByText('observed').length).toBeGreaterThanOrEqual(4)
    expect(screen.getAllByText('calculated').length).toBeGreaterThanOrEqual(3)
    expect(screen.getByTestId('exposure-formulas')).toHaveTextContent(/Cavg,ss = AUCτ/)
  })

  it('keeps the observed metrics but refuses the steady-state ones off steady state', () => {
    renderRepeated({ ...steadyState, regimen: 'repeated-dose' })
    selectInterval()

    expect(screen.getByTestId('exposure-cmax-obs')).toHaveTextContent('100 mg/L')
    expect(screen.getByTestId('exposure-cavg-interval')).toHaveTextContent('70 mg/L')
    expect(screen.getByTestId('exposure-cavg-ss')).toHaveTextContent('—')
    expect(screen.getByTestId('exposure-cavg-ss-status')).toHaveTextContent('not applicable')
    expect(screen.getByTestId('exposure-fluctuation-status')).toHaveTextContent('not applicable')
    expect(screen.getByTestId('exposure-unavailable')).toHaveTextContent(/REGIMEN_NOT_STEADY_STATE/)
  })

  it('refuses every metric until an interval is selected', () => {
    renderRepeated()
    expect(screen.getByTestId('exposure-summary')).toBeInTheDocument()
    expect(screen.getByTestId('exposure-cmax-obs')).toHaveTextContent('—')
    expect(screen.getByTestId('exposure-cmax-obs-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('exposure-unavailable')).toHaveTextContent(/INTERVAL_NOT_SELECTED/)
    expect(screen.queryByTestId('exposure-peak-observations')).not.toBeInTheDocument()
    expect(screen.getByTestId('exposure-inputs')).toHaveTextContent(/not selected/)
  })

  it('withholds the steady-state metrics until the interval is confirmed', () => {
    renderRepeated()
    selectInterval('0', '12', false)
    expect(screen.getByTestId('exposure-cmax-obs')).toHaveTextContent('100 mg/L')
    expect(screen.getByTestId('exposure-cavg-ss-status')).toHaveTextContent('unavailable')
    expect(screen.getByTestId('exposure-unavailable')).toHaveTextContent(/INTERVAL_NOT_ALIGNED/)
    expect(screen.getByTestId('exposure-fluctuation-status')).toHaveTextContent('unavailable')
  })

  it('lists every observation that attains a tied peak', () => {
    render(
      <NcaCard
        measurements={rows([
          [0, 100],
          [2, 100],
          [4, 80],
          [6, 40],
          [8, 60],
          [10, 50],
          [12, 40],
        ])}
        timeUnit="h"
        concentrationUnit="mg/L"
        administration={steadyState}
      />,
    )
    selectInterval()

    expect(screen.getByTestId('exposure-cmax-obs-status')).toHaveTextContent('conditional')
    const peakItems = screen.getAllByTestId('exposure-peak-observations-item')
    expect(peakItems).toHaveLength(2)
    expect(peakItems[0]).toHaveTextContent(/source row 1$/)
    expect(peakItems[1]).toHaveTextContent(/source row 2$/)
    expect(screen.getByTestId('exposure-conditional')).toHaveTextContent(/cmax-obs/)
    expect(screen.getByTestId('exposure-cmin-obs-status')).toHaveTextContent('conditional')
    const troughItems = screen.getAllByTestId('exposure-trough-observations-item')
    expect(troughItems).toHaveLength(2)
    expect(troughItems[0]).toHaveTextContent(/source row 4$/)
    expect(troughItems[1]).toHaveTextContent(/source row 7$/)
  })

  it('refuses the metrics for an interval that is not one τ wide', () => {
    renderRepeated()
    selectInterval('0', '8')
    expect(screen.getByTestId('exposure-cmax-obs')).toHaveTextContent('—')
    expect(screen.getByTestId('exposure-unavailable')).toHaveTextContent(/INTERVAL_AUC_UNAVAILABLE/)
  })
})
