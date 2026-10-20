import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SimulationView } from './SimulationView'
import { DEMO_SCENARIO, DEMO_SCENARIO_ROWS } from './demoScenario'

/**
 * Page-level behaviour of the simulation demonstration.
 *
 * Plotly itself is not exercised here (the e2e suite renders the real chart);
 * these tests assert what the page shows and what it calls.
 */

// Replace the lazy chart with a lightweight stub: the adapter is tested
// separately and Plotly would need a real DOM.
vi.mock('@/components/charts/SimulationChart', () => ({
  SimulationChart: ({ chart }: { chart: { id: string; traces: readonly { x: readonly number[]; y: readonly number[] }[] } }) => (
    <div data-testid={`stub-chart-${chart.id}`}>
      {chart.traces.map((trace) => (
        <span key={JSON.stringify([trace.x.length, trace.y.length])}>
          {trace.x.length}
        </span>
      ))}
    </div>
  ),
}))

// Spy on the engine orchestration to prove the page calls the real API with
// the documented scenario, while still returning a real report. `failureFor`
// lets one test make the engine report a structured failure.
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
const simulateSpy = {
  calls: control.calls,
  get mock() {
    return { calls: control.calls }
  },
  calledTimes: () => control.calls.length,
  lastCall: () => control.calls[control.calls.length - 1],
}

const renderView = () => render(<SimulationView />)
const runButton = () => screen.getByRole('button', { name: /run demonstration/i })

beforeEach(() => {
  control.calls.length = 0
  control.failureFor = null
})

describe('SimulationView — labelling and scenario', () => {
  it('labels the whole page as a synthetic demonstration', () => {
    renderView()
    const notice = screen.getByTestId('synthetic-scenario-notice')
    expect(within(notice).getByText(/synthetic demonstration scenario/i)).toBeInTheDocument()
    expect(notice).toHaveTextContent(/not real compound parameters/i)
    expect(notice).toHaveTextContent(/not clinical estimates/i)
    expect(notice).toHaveTextContent(/not a clinical prediction/i)
  })

  it('shows every documented scenario parameter with its unit', () => {
    renderView()
    const panel = screen.getByTestId('scenario-parameters')
    // Labels and values can repeat ("IV bolus" twice, "0 mg" twice), so each
    // documented row is asserted as present rather than unique.
    for (const row of DEMO_SCENARIO_ROWS) {
      expect(within(panel).getAllByText(row.label).length).toBeGreaterThan(0)
      expect(within(panel).getAllByText(row.value).length).toBeGreaterThan(0)
    }
    expect(panel).toHaveTextContent('10 L')
    expect(panel).toHaveTextContent('2 L/h')
    expect(panel).toHaveTextContent('100 mg at t = 0 h')
    expect(panel).toHaveTextContent('10 mg/h from t = 2 h to t = 6 h')
    expect(panel).toHaveTextContent('30 mg at t = 8 h')
    expect(panel).toHaveTextContent('0–24 h')
  })

  it('shows an idle state before any run and no charts', () => {
    renderView()
    expect(screen.getByTestId('simulation-idle')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(simulateSpy.calledTimes()).toBe(0)
  })
})

describe('SimulationView — running the demonstration', () => {
  it('calls the real simulation orchestration with the documented scenario', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    expect(simulateSpy.calledTimes()).toBe(1)
    expect(simulateSpy.lastCall()).toEqual(DEMO_SCENARIO)
  })

  it('renders both charts after a successful run', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-chart-amount')).toBeInTheDocument()
    expect(screen.queryByTestId('simulation-idle')).not.toBeInTheDocument()
    expect(screen.getByTestId('simulation-summary')).toHaveTextContent(/two-compartment/i)
  })

  it('lists every dosing event, keeping same-time events separate', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    const table = await screen.findByTestId('event-table')
    expect(within(table).getByTestId('event-row-demo-bolus-1')).toBeInTheDocument()
    expect(within(table).getByTestId('event-row-demo-infusion-start-1')).toBeInTheDocument()
    expect(within(table).getByTestId('event-row-demo-infusion-stop-1')).toBeInTheDocument()
    expect(within(table).getByTestId('event-row-demo-bolus-2')).toBeInTheDocument()
    // The stop is labelled as a stop, never as an administered dose.
    expect(within(table).getByTestId('event-row-demo-infusion-stop-1')).toHaveTextContent(
      /no amount administered/i,
    )
    expect(within(table).getByTestId('event-row-demo-bolus-2')).toHaveTextContent('30 mg')
  })

  it('shows solver, mass-balance, parameter and assumption diagnostics', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    expect(await screen.findByTestId('solver-diagnostics')).toHaveTextContent(/dormand-prince-rk45/i)
    expect(screen.getByTestId('solver-diagnostics')).toHaveTextContent(/derivative evaluations/i)
    const mass = screen.getByTestId('mass-balance-diagnostics')
    expect(mass).toHaveTextContent(/within tolerance/i)
    expect(mass).toHaveTextContent(/acceptance tolerance/i)
    expect(screen.getByTestId('model-equations')).toHaveTextContent('dA_c/dt')
    expect(screen.getByTestId('model-assumptions')).toHaveTextContent(/linear/i)
    expect(screen.getByTestId('qualification-note')).toHaveTextContent(/does not mean/i)
  })

  it('reruns deterministically and labels the new run', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    expect(screen.getByTestId('simulation-summary')).toHaveTextContent('Run 1')
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    expect(screen.getByTestId('simulation-summary')).toHaveTextContent('Run 2')
    expect(simulateSpy.calledTimes()).toBe(2)
  })

  it('exposes the model warnings (including the not-clinical warning)', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    const warnings = await screen.findByTestId('simulation-warnings')
    expect(warnings).toHaveTextContent('MODEL_RESULT_NOT_CLINICAL')
    expect(warnings).toHaveTextContent('MODEL_LIMITATION')
  })
})

describe('SimulationView — failures', () => {
  it('shows the error and leaves no chart or stale success', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')

    // Second run fails: the previous success must disappear.
    control.failureFor = (call) =>
      call === 2
        ? {
            ok: false,
            model: 'pnk.two-compartment-iv',
            errors: [
              {
                code: 'INVALID_EVENT_SEQUENCE',
                stage: 'events',
                eventId: 'demo-bolus-2',
                message: 'Synthetic failure injected for the test.',
              },
            ],
          }
        : null
    await user.click(runButton())

    const error = await screen.findByTestId('simulation-errors')
    expect(error).toHaveTextContent('INVALID_EVENT_SEQUENCE')
    expect(error).toHaveTextContent('Synthetic failure injected for the test.')
    expect(error).toHaveTextContent(/no results are shown/i)
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(screen.queryByTestId('stub-chart-amount')).not.toBeInTheDocument()
    expect(screen.queryByTestId('simulation-summary')).not.toBeInTheDocument()
  })
})

describe('SimulationView — keyboard', () => {
  it('reaches and activates the run action with the keyboard', async () => {
    const user = userEvent.setup()
    renderView()
    const button = runButton()
    button.focus()
    expect(button).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    expect(simulateSpy.calledTimes()).toBe(1)
  })
})
