import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationView } from './SimulationView'
import { FakeScenarioRepository } from './tests/fakeScenarioRepository'
import { DEMO_SCENARIO } from './tests/demoScenario'

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
const renderView = () => render(<SimulationView scenarioRepository={repository} />)

/**
 * Explicit fixture setup for tests exercising a successful run. The product
 * editor itself now starts blank; these values are test inputs, not UI defaults.
 */
const renderConfiguredView = () => {
  const view = renderView()
  const setValue = (testId: string, value: string) =>
    fireEvent.change(screen.getByTestId(testId), { target: { value } })

  for (const [testId, value] of [
    ['central-volume-value', '10'],
    ['peripheral-volume-value', '20'],
    ['clearance-value', '2'],
    ['q-value', '3'],
    ['initial-central-value', '0'],
    ['initial-peripheral-value', '0'],
    ['start-time-value', '0'],
    ['end-time-value', '24'],
    ['output-interval-value', '0.25'],
  ] as const) {
    setValue(testId, value)
  }

  fireEvent.click(screen.getByTestId('add-bolus'))
  setValue('bolus-1-time', '0')
  setValue('bolus-1-amount', '100')

  fireEvent.click(screen.getByTestId('add-bolus'))
  setValue('bolus-2-time', '8')
  setValue('bolus-2-amount', '30')

  fireEvent.click(screen.getByTestId('add-infusion'))
  setValue('infusion-3-start', '2')
  setValue('infusion-3-stop', '6')
  setValue('infusion-3-rate', '10')
  return view
}
const runOnce = async () => {
  const user = userEvent.setup()
  await user.click(runButton())
  return user
}

let repository: FakeScenarioRepository

beforeEach(() => {
  repository = new FakeScenarioRepository()
  control.calls.length = 0
  control.failureFor = null
})

describe('SimulationView — blank starting state and editing', () => {
  it('starts with blank scientific and horizon inputs, no dose rows, and no synthetic-values warning', () => {
    renderView()
    expect(screen.queryByTestId('synthetic-scenario-notice')).not.toBeInTheDocument()
    for (const testId of [
      'central-volume-value',
      'peripheral-volume-value',
      'clearance-value',
      'q-value',
      'initial-central-value',
      'initial-peripheral-value',
      'start-time-value',
      'end-time-value',
      'output-interval-value',
    ]) {
      expect(screen.getByTestId(testId)).toHaveValue('')
    }
    expect(screen.getByTestId('no-events')).toBeInTheDocument()
    expect(screen.getByTestId('simulation-idle')).toBeInTheDocument()
  })

  it('keeps solver configuration defaults in the collapsed advanced section', () => {
    renderView()
    expect(screen.getByTestId('solver-absolute-tolerance')).toHaveValue('1e-10')
    expect(screen.getByTestId('solver-max-steps')).toHaveValue('200000')
    const details = screen.getByTestId('solver-section')
    expect(details.tagName).toBe('DETAILS')
    expect(details).not.toHaveAttribute('open')
    expect(within(details).getByText(/advanced solver settings/i)).toBeInTheDocument()
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
      const labelElement = document.querySelector(`label[for="${id}"]`)
      expect(labelElement?.textContent ?? '').toMatch(new RegExp(label))
      expect(screen.getByTestId(testId)).toHaveAttribute('id', id)
    }
    expect(screen.getByLabelText('Central volume unit')).toHaveValue('L')
    expect(screen.getByLabelText('Systemic clearance unit')).toHaveValue('L/h')
  })

  it('does not add dosing rows until the user requests them', () => {
    renderView()
    expect(screen.getByTestId('no-events')).toBeInTheDocument()
    expect(screen.queryByTestId('event-row-1')).not.toBeInTheDocument()
    expect(screen.queryByTestId('bolus-1-amount')).not.toBeInTheDocument()
  })
})

describe('SimulationView — running', () => {
  it('calls the real engine exactly once with the explicitly entered scenario', async () => {
    renderConfiguredView()
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
    renderConfiguredView()
    const user = userEvent.setup()
    await user.type(screen.getByTestId('clearance-value'), '5')
    expect(control.calls).toHaveLength(0)
  })

  it('renders the concentration view, events and diagnostics from the actual report', async () => {
    renderConfiguredView()
    await runOnce()
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    expect(screen.getByTestId('simulation-summary')).toHaveTextContent('Run 1')
    expect(within(screen.getByTestId('event-table')).getByText('Infusion start')).toBeInTheDocument()
    expect(screen.getByTestId('mass-balance-diagnostics')).toHaveTextContent(/within tolerance/i)
    expect(screen.getByTestId('solver-diagnostics')).toHaveTextContent(/derivative evaluations/i)
    expect(screen.getByTestId('model-assumptions')).toHaveTextContent(/central compartment/i)
    expect(screen.getByTestId('qualification-note')).toHaveTextContent(/does not mean/i)
  })

  it('passes edited solver settings through instead of replacing them', async () => {
    renderConfiguredView()
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
    renderConfiguredView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    const first = control.calls[0]
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    expect(screen.getByTestId('simulation-summary')).toHaveTextContent('Run 2')
    expect(JSON.stringify(control.calls[1])).toBe(JSON.stringify(first))
  })

  it('is reachable and activatable from the keyboard', async () => {
    renderConfiguredView()
    const user = userEvent.setup()
    runButton().focus()
    expect(runButton()).toHaveFocus()
    await user.keyboard('{Enter}')
    expect(control.calls).toHaveLength(1)
  })
})

describe('SimulationView — stale results and failures', () => {
  it('clears a successful result as soon as the draft changes', async () => {
    renderConfiguredView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    await user.type(screen.getByTestId('clearance-value'), '1')
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(screen.queryByTestId('simulation-summary')).not.toBeInTheDocument()
    expect(screen.getByTestId('simulation-idle')).toBeInTheDocument()
  })

  it('shows typed engine errors and no chart when the engine rejects the scenario', async () => {
    renderConfiguredView()
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
    renderConfiguredView()
    const user = userEvent.setup()
    await user.clear(screen.getByTestId('end-time-value'))
    await user.click(runButton())
    expect(control.calls).toHaveLength(0)
    const summary = await screen.findByTestId('form-errors')
    // The summary names the field once (from the shared metadata) and then
    // states the problem; the sentence must not repeat the parameter name.
    expect(summary.textContent).toContain('End time (h): A value is required.')
    expect(summary.textContent).not.toContain('End time (h): End time')
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
  })

  it('marks the offending field and associates the message with it', async () => {
    renderConfiguredView()
    const user = userEvent.setup()
    await user.clear(screen.getByTestId('clearance-value'))
    await user.type(screen.getByTestId('clearance-value'), 'abc')
    const input = screen.getByTestId('clearance-value')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    const describedBy = input.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(/must be a finite number/i)
  })

  it('never lets a prior success stand in for a failed run', async () => {
    renderConfiguredView()
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

describe('SimulationView — clear scenario', () => {
  it('clears all scenario inputs and invalidates the previous result', async () => {
    renderConfiguredView()
    const user = userEvent.setup()
    await user.clear(screen.getByTestId('central-volume-value'))
    await user.type(screen.getByTestId('central-volume-value'), '42')
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    await user.click(screen.getByTestId('clear-scenario'))
    expect(screen.getByTestId('central-volume-value')).toHaveValue('')
    expect(screen.getByTestId('output-interval-value')).toHaveValue('')
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()
    expect(screen.queryByTestId('event-row-1')).not.toBeInTheDocument()
    expect(screen.getByTestId('no-events')).toBeInTheDocument()
    expect(screen.getByTestId('solver-max-steps')).toHaveValue('200000')
  })
})

describe('SimulationView — chart views', () => {
  it('shows one analysis view at a time and switches without re-running the engine', async () => {
    renderConfiguredView()
    const user = await runOnce()
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-chart-amount')).not.toBeInTheDocument()
    expect(control.calls).toHaveLength(1)

    await user.click(screen.getByTestId('view-tab-amount'))
    expect(await screen.findByTestId('stub-chart-amount')).toBeInTheDocument()
    expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('view-tab-infusion-rate'))
    expect(await screen.findByTestId('stub-chart-infusion-rate')).toBeInTheDocument()

    await user.click(screen.getByTestId('view-tab-concentration'))
    expect(await screen.findByTestId('stub-chart-concentration')).toBeInTheDocument()
    // Selecting a view never runs the simulation again.
    expect(control.calls).toHaveLength(1)
  })

  it('the deferred post-run focus never steals focus from a control the user moved to', async () => {
    renderConfiguredView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    // The run's focus move is deferred to an animation frame. Moving focus
    // to a tab before that frame must not be undone, or the next keystroke
    // lands on the results container and is lost.
    const tab = screen.getByTestId('view-tab-concentration')
    tab.focus()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(tab).toHaveFocus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByTestId('view-tab-amount')).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByTestId('view-tab-amount')).toHaveFocus()
  })

  it('exposes the view switcher as a radio group with an accessible name', async () => {
    renderConfiguredView()
    await runOnce()
    const group = await screen.findByRole('radiogroup', { name: 'Chart view' })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(3)
    expect(within(group).getByRole('radio', { name: /concentration/i })).toHaveAttribute('aria-checked', 'true')
    expect(within(group).getByRole('radio', { name: /amount/i })).toHaveAttribute('aria-checked', 'false')
  })

  it('moves selection and focus with the arrow keys, wrapping around', async () => {
    renderConfiguredView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    const tab = (view: string) => screen.getByTestId(`view-tab-${view}`)

    tab('concentration').focus()
    expect(tab('concentration')).toHaveFocus()

    // Forward: focus AND checked state follow the selection.
    await user.keyboard('{ArrowRight}')
    expect(tab('amount')).toHaveAttribute('aria-checked', 'true')
    expect(tab('amount')).toHaveFocus()
    expect(await screen.findByTestId('stub-chart-amount')).toBeInTheDocument()

    await user.keyboard('{ArrowRight}')
    expect(tab('infusion-rate')).toHaveAttribute('aria-checked', 'true')
    expect(tab('infusion-rate')).toHaveFocus()

    // Wrap-around from the last view back to the first.
    await user.keyboard('{ArrowRight}')
    expect(tab('concentration')).toHaveAttribute('aria-checked', 'true')
    expect(tab('concentration')).toHaveFocus()

    // Reverse navigation, including wrap-around backwards.
    await user.keyboard('{ArrowLeft}')
    expect(tab('infusion-rate')).toHaveAttribute('aria-checked', 'true')
    expect(tab('infusion-rate')).toHaveFocus()
    await user.keyboard('{ArrowLeft}')
    expect(tab('amount')).toHaveAttribute('aria-checked', 'true')
    expect(tab('amount')).toHaveFocus()
    expect(control.calls).toHaveLength(1)
  })

  it('keeps Tab entering the group at the selected option', async () => {
    renderConfiguredView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    const tab = (view: string) => screen.getByTestId(`view-tab-${view}`)
    // Exactly one tab stop, and it is the selected view.
    expect(tab('concentration')).toHaveAttribute('tabindex', '0')
    expect(tab('amount')).toHaveAttribute('tabindex', '-1')
    await user.click(tab('amount'))
    expect(tab('amount')).toHaveAttribute('tabindex', '0')
    expect(tab('concentration')).toHaveAttribute('tabindex', '-1')
  })

  it('Home and End jump to the first and last available views', async () => {
    renderConfiguredView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    screen.getByTestId('view-tab-amount').focus()
    await user.keyboard('{End}')
    expect(screen.getByTestId('view-tab-infusion-rate')).toHaveFocus()
    expect(screen.getByTestId('view-tab-infusion-rate')).toHaveAttribute('aria-checked', 'true')
    await user.keyboard('{Home}')
    expect(screen.getByTestId('view-tab-concentration')).toHaveFocus()
    expect(screen.getByTestId('view-tab-concentration')).toHaveAttribute('aria-checked', 'true')
  })

  it('disables and explains the infusion view when the scenario has no infusion', async () => {
    renderConfiguredView()
    const user = userEvent.setup()
    await user.click(screen.getByTestId('remove-event-3')) // remove the example infusion
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')
    const tab = screen.getByTestId('view-tab-infusion-rate')
    expect(tab).toBeDisabled()
    expect(tab).toHaveAttribute('aria-checked', 'false')
    expect(screen.getByTestId('view-availability-note')).toHaveTextContent(/no infusion/i)
    expect(screen.queryByTestId('stub-chart-infusion-rate')).not.toBeInTheDocument()

    // Arrow keys skip the unavailable view and never focus it.
    screen.getByTestId('view-tab-concentration').focus()
    await user.keyboard('{ArrowRight}') // concentration -> amount
    expect(screen.getByTestId('view-tab-amount')).toHaveFocus()
    await user.keyboard('{ArrowRight}') // wraps past the disabled infusion view
    expect(screen.getByTestId('view-tab-concentration')).toHaveFocus()
    expect(screen.getByTestId('view-tab-infusion-rate')).not.toHaveFocus()
    await user.keyboard('{ArrowLeft}') // backwards: wraps to amount, skipping infusion
    expect(screen.getByTestId('view-tab-amount')).toHaveFocus()
    expect(screen.getByTestId('view-tab-infusion-rate')).toHaveAttribute('tabindex', '-1')
  })

  it('keeps the event table and diagnostics visible regardless of the active view', async () => {
    renderConfiguredView()
    const user = await runOnce()
    await screen.findByTestId('stub-chart-concentration')
    for (const view of ['amount', 'infusion-rate', 'concentration']) {
      await user.click(screen.getByTestId(`view-tab-${view}`))
      expect(screen.getByTestId('event-table')).toBeInTheDocument()
      expect(screen.getByTestId('solver-diagnostics')).toBeInTheDocument()
      expect(screen.getByTestId('mass-balance-diagnostics')).toBeInTheDocument()
    }
  })
})

describe('SimulationView — repeat regimens', () => {
  it('expands a repeated dose into the explicit schedule preview', () => {
    renderView()
    fireEvent.click(screen.getByTestId('add-bolus'))
    fireEvent.change(screen.getByTestId('bolus-1-time'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('bolus-1-amount'), { target: { value: '10' } })
    fireEvent.change(screen.getByTestId('repeat-1-count'), { target: { value: '3' } })
    fireEvent.change(screen.getByTestId('repeat-1-interval'), { target: { value: '6' } })

    const preview = screen.getByTestId('expanded-schedule')
    expect(preview).toBeInTheDocument()
    // Three doses at 2, 8 and 14 h, one row each.
    expect(screen.getByTestId('expanded-dose-1-1')).toHaveTextContent('2')
    expect(screen.getByTestId('expanded-dose-1-2')).toHaveTextContent('8')
    expect(screen.getByTestId('expanded-dose-1-3')).toHaveTextContent('14')
  })

  it('flags a missing repeat interval when the dose is repeated', () => {
    renderView()
    fireEvent.click(screen.getByTestId('add-bolus'))
    fireEvent.change(screen.getByTestId('bolus-1-time'), { target: { value: '2' } })
    fireEvent.change(screen.getByTestId('bolus-1-amount'), { target: { value: '10' } })
    fireEvent.change(screen.getByTestId('repeat-1-count'), { target: { value: '3' } })
    expect(screen.getByTestId('repeat-1-interval')).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getAllByText(/repeat interval is required/i).length).toBeGreaterThan(0)
  })
})