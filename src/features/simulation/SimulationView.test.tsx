import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationView } from './SimulationView'
import { DEMO_SCENARIO } from './demoScenario'

/**
 * Page behaviour of the phase-43 scenario editor.
 *
 * Plotly is replaced by a lightweight stub (the real chart is exercised in
 * the E2E suite); everything else — the real draft compiler, the real engine
 * and the real adapter — runs unmodified.
 */

vi.mock('@/components/charts/SimulationChart', () => ({
  SimulationChart: ({
    chart,
  }: {
    chart: { id: string; traces: readonly { x: readonly number[]; y: readonly number[] }[] }
  }) => (
    <div data-testid={`stub-chart-${chart.id}`}>
      {chart.traces.map((trace, index) => (
        <span key={index}>{trace.x.length}</span>
      ))}
    </div>
  ),
}))

const control = vi.hoisted(() => ({
  calls: [] as unknown[],
  failureFor: null as null | ((call: number) => unknown),
}))
vi.mock('@/engine/simulation/simulate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/simulation/simulate')>()
  return {
    ...actual,
    simulate: (scenario: Parameters<typeof actual.simulate>[0]) => {
      control.calls.push(scenario)
      const forced = control.failureFor?.(control.calls.length)
      if (forced !== undefined && forced !== null) return forced
      return actual.simulate(scenario)
    },
  }
})

const runButton = () => screen.getByTestId('run-simulation')
const renderView = () => render(<SimulationView />)
const runOnce = async () => {
  const user = userEvent.setup()
  await user.click(runButton())
  return user
}

beforeEach(() => {
  control.calls.length = 0
  control.failureFor = null
})

describe('SimulationView — synthetic example and editing', () => {
  it('labels the example as synthetic and says user values are not verified', () => {
    renderView()
    const notice = screen.getByTestId('synthetic-scenario-notice')
    expect(notice).toHaveTextContent(/synthetic example scenario/i)
    expect(notice).toHaveTextContent(/not real compound parameters/i)
    expect(notice).toHaveTextContent(/your own inputs/i)
    expect(screen.getByTestId('simulation-idle')).toBeInTheDocument()
  })

  it('seeds every field from the documented example values', () => {
    renderView()
    expect(screen.getByTestId('central-volume-value')).toHaveValue('10')
    expect(screen.getByTestId('peripheral-volume-value')).toHaveValue('20')
    expect(screen.getByTestId('clearance-value')).toHaveValue('2')
    expect(screen.getByTestId('q-value')).toHaveValue('3')
    expect(screen.getByTestId('initial-central-value')).toHaveValue('0')
    expect(screen.getByTestId('initial-peripheral-value')).toHaveValue('0')
    expect(screen.getByTestId('start-time-value')).toHaveValue('0')
    expect(screen.getByTestId('end-time-value')).toHaveValue('24')
    expect(screen.getByTestId('output-interval-value')).toHaveValue('0.25')
    expect(screen.getByTestId('solver-absolute-tolerance')).toHaveValue('1e-10')
    expect(screen.getByTestId('solver-max-steps')).toHaveValue('200000')
  })

  it('gives every parameter field an accessible name that includes its symbol', () => {
    renderView()
    // Every control is reached through its own label element; `getByLabelText`
    // alone would also match the unit select's "… unit" label.
    const labelledBy = (testId: string): string =>
      screen.getByTestId(testId).closest('div[data-field-path]')?.querySelector('label')?.htmlFor ?? ''
    for (const [label, testId] of [
      ['Central volume', 'central-volume-value'],
      ['Peripheral volume', 'peripheral-volume-value'],
      ['Systemic clearance', 'clearance-value'],
      ['Intercompartmental clearance', 'q-value'],
      ['Initial central amount \\(mg', 'initial-central-value'],
      ['Initial peripheral amount \\(mg', 'initial-peripheral-value'],
      ['Start time \\(h\\)', 'start-time-value'],
      ['End time \\(h\\)', 'end-time-value'],
      ['Output interval \\(h\\)', 'output-interval-value'],
    ] as const) {
      const id = labelledBy(testId)
      expect(id).not.toBe('')
      // The control's own <label for=…> carries the accessible name.
      const labelElement = document.querySelector(`label[for="${id}"]`)
      expect(labelElement?.textContent ?? '').toMatch(new RegExp(label))
      expect(screen.getByTestId(testId)).toHaveAttribute('id', id)
    }
    // Unit selects are labelled too.
    expect(screen.getByLabelText('Central volume unit')).toHaveValue('L')
    expect(screen.getByLabelText('Systemic clearance unit')).toHaveValue('L/h')
  })

  it('shows the example rows (two boluses, one infusion) with their values', () => {
    renderView()
    // The example compiles to bolus, bolus, infusion in row order.
    expect(screen.getByTestId('event-row-1')).toHaveTextContent('IV bolus')
    expect(screen.getByTestId('event-row-2')).toHaveTextContent('IV bolus')
    expect(screen.getByTestId('event-row-3')).toHaveTextContent('IV infusion')
    expect(screen.getByTestId('bolus-1-amount')).toHaveValue('100')
    expect(screen.getByTestId('bolus-1-time')).toHaveValue('0')
    expect(screen.getByTestId('bolus-2-amount')).toHaveValue('30')
    expect(screen.getByTestId('infusion-3-start')).toHaveValue('2')
    expect(screen.getByTestId('infusion-3-stop')).toHaveValue('6')
    expect(screen.getByTestId('infusion-3-rate')).toHaveValue('10')
  })

  it('keeps the advanced solver settings in a collapsed advanced section', () => {
    renderView()
    const details = screen.getByTestId('solver-section')
    expect(details.tagName).toBe('DETAILS')
    expect(within(details).getByText(/advanced solver settings/i)).toBeInTheDocument()
  })
})

describe('SimulationView — running', () => {
  it('calls the real engine exactly once per run with the compiled example scenario', async () => {
    renderView()
    await runOnce()
    expect(control.calls).toHaveLength(1)
    const scenario = control.calls[0] as typeof DEMO_SCENARIO
    expect(scenario.startTime).toBe(0)
    expect(scenario.endTime).toBe(24)
    expect(scenario.outputTimes).toHaveLength(97)
    expect(scenario.events).toHaveLength(4)
    expect(scenario.parameters.centralVolume).toEqual({ value: 10, unit: 'L' })
  })

  it('does not run while typing or on render', async () => {
    renderView()
    const user = userEvent.setup()
    await user.type(screen.getByTestId('clearance-value'), '5')
    expect(control.calls).toHaveLength(0)
  })

  it('renders charts, events and diagnostics from the actual report', async () => {
    renderView()
    await runOnce()
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-chart-amount')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-chart-infusion-rate')).toBeInTheDocument()
    expect(screen.getByTestId('simulation-summary')).toHaveTextContent('Run 1')
    expect(within(screen.getByTestId('event-table')).getByText('Infusion start')).toBeInTheDocument()
    expect(screen.getByTestId('mass-balance-diagnostics')).toHaveTextContent(/within tolerance/i)
    expect(screen.getByTestId('solver-diagnostics')).toHaveTextContent(/derivative evaluations/i)
    expect(screen.getByTestId('model-assumptions')).toHaveTextContent(/central compartment/i)
    expect(screen.getByTestId('qualification-note')).toHaveTextContent(/does not mean/i)
  })

  it('passes edited solver settings through instead of replacing them', async () => {
    renderView()
    const user = userEvent.setup()
    const tolerance = screen.getByTestId('solver-absolute-tolerance')
    await user.clear(tolerance)
    await user.type(tolerance, '1e-6')
    await user.click(runButton())
    const scenario = control.calls[0] as typeof DEMO_SCENARIO
    expect(scenario.solver.absoluteTolerance).toBe(1e-6)
    expect(screen.getByTestId('solver-diagnostics')).toHaveTextContent(/Absolute \/ relative tolerance/);
  })

  it('reruns deterministically and labels the new run', async () => {
    renderView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    const first = control.calls[0]
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    expect(screen.getByTestId('simulation-summary')).toHaveTextContent('Run 2')
    expect(JSON.stringify(control.calls[1])).toBe(JSON.stringify(first))
  })

  it('is reachable and activatable from the keyboard', async () => {
    renderView()
    const user = userEvent.setup()
    runButton().focus()
    expect(runButton()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(control.calls).toHaveLength(1)
  })
})

describe('SimulationView — stale results and failures', () => {
  it('clears a successful result as soon as the draft changes', async () => {
    renderView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    await user.type(screen.getByTestId('clearance-value'), '1')
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(screen.queryByTestId('simulation-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('simulation-idle')).toBeInTheDocument()
  })

  it('shows typed engine errors and no chart when the engine rejects the scenario', async () => {
    renderView()
    const user = userEvent.setup()
    await user.clear(screen.getByTestId('central-volume-value'))
    await user.type(screen.getByTestId('central-volume-value'), '0')
    await user.click(runButton())
    const errors = await screen.findByTestId('simulation-errors')
    expect(errors).toHaveTextContent('ZERO_NOT_ALLOWED')
    expect(errors).toHaveTextContent(/Central volume/)
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    // The error is also attributed to the engine channel of the summary.
    expect(screen.getByTestId('engine-errors')).toHaveTextContent('ZERO_NOT_ALLOWED')
  })

  it('does not call the engine with an unparseable draft and explains why', async () => {
    renderView()
    const user = userEvent.setup()
    await user.clear(screen.getByTestId('end-time-value'))
    await user.click(runButton())
    expect(control.calls).toHaveLength(0)
    const summary = await screen.findByTestId('form-errors')
    expect(summary).toHaveTextContent(/End time is required/)
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
  })

  it('marks the offending field and associates the message with it', async () => {
    renderView()
    const user = userEvent.setup()
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), 'abc')
    const input = screen.getByTestId('clearance-value')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(/must be a finite number/)
  })

  it('never lets a prior success stand in for a failed run', async () => {
    renderView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    control.failureFor = (call) =>
      call === 2
        ? {
            ok: false,
            model: 'pnk.two-compartment-iv',
            errors: [
              { code: 'INVARIANT_VIOLATION', stage: 'invariants', message: 'Synthetic injected failure.' },
            ],
          }
        : null
    await user.click(runButton())
    expect(await screen.findByTestId('simulation-errors')).toHaveTextContent('Synthetic injected failure.')
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
  })
})

describe('SimulationView — reset', () => {
  it('restores the whole example and invalidates the previous result', async () => {
    renderView()
    const user = userEvent.setup()
    await user.clear(screen.getByTestId('central-volume-value'))
    await user.type(screen.getByTestId('central-volume-value'), '42')
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    await user.click(screen.getByTestId('reset-demo'))
    expect(screen.getByTestId('central-volume-value')).toHaveValue('10')
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(screen.getByTestId('bolus-1-amount')).toHaveValue('100')
    expect(screen.getByTestId('infusion-3-stop')).toHaveValue('6')
    expect(screen.getByTestId('solver-max-steps')).toHaveValue('200000')
  })
})

describe('SimulationView — chart toggles', () => {
  it('hides and shows charts without running the engine again', async () => {
    renderView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    expect(control.calls).toHaveLength(1)
    await user.click(screen.getByTestId('toggle-concentration'))
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(screen.getByTestId('stub-chart-amount')).toBeInTheDocument()
    await user.click(screen.getByTestId('toggle-concentration'))
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    expect(control.calls).toHaveLength(1)
  })

  it('reports when every chart is hidden but keeps the diagnostics', async () => {
    renderView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    for (const id of ['toggle-concentration', 'toggle-amount', 'toggle-infusionRate']) {
      await user.click(screen.getByTestId(id))
    }
    expect(screen.getByTestId('no-charts-shown')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(screen.getByTestId('solver-diagnostics')).toBeInTheDocument()
  })

  it('disables the infusion-rate toggle when the scenario has no infusion', async () => {
    renderView()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('remove-event-3')) // remove the example infusion (row 3)
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    const toggle = screen.getByTestId('toggle-infusionRate')
    expect(toggle).toBeDisabled()
    expect(toggle).not.toBeChecked()
    expect(screen.queryByTestId('stub-chart-infusion-rate')).not.toBeInTheDocument()
  })
})
