import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulationView } from './SimulationView'
import { FakeScenarioRepository } from './tests/fakeScenarioRepository'

/**
 * Effect-site editor and chart views (phase 46).
 *
 * Proves the opt-in contract end to end at the UI boundary: nothing is
 * defaulted, blank text stays editable, invalid configurations never reach
 * `simulate()`, the new views appear only when the run produced their series,
 * and view switching is presentation-only.
 */

vi.mock('@/components/charts/SimulationChart', () => ({
  SimulationChart: ({ chart }: { chart: { id: string } }) => <div data-testid={`stub-chart-${chart.id}`} />,
}))

const control = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/engine/simulation/simulate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/engine/simulation/simulate')>()
  return {
    ...actual,
    simulate: (scenario: Parameters<typeof actual.simulate>[0]) => {
      control.calls += 1
      return actual.simulate(scenario)
    },
  }
})

let repository: FakeScenarioRepository
beforeEach(() => {
  control.calls = 0
  repository = new FakeScenarioRepository()
})

const renderView = () => render(<SimulationView scenarioRepository={repository} />)
const runButton = () => screen.getByTestId('run-simulation')

async function enableEffectSite(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('effect-site-enabled'))
}

describe('effect-site editor', () => {
  it('starts PK-only with the controls hidden', () => {
    renderView()
    const toggle = screen.getByTestId('effect-site-enabled')
    expect(toggle).not.toBeChecked()
    expect(screen.queryByTestId('effect-site-fu')).not.toBeInTheDocument()
  })

  it('reveals the parameter controls when enabled and keeps entered values when disabled', async () => {
    const user = userEvent.setup()
    renderView()
    await enableEffectSite(user)
    await user.type(screen.getByTestId('effect-site-fu'), '0.5')
    await user.click(screen.getByTestId('effect-site-enabled'))
    expect(screen.queryByTestId('effect-site-fu')).not.toBeInTheDocument()
    // Re-enabling keeps what was typed: nothing was silently cleared.
    await user.click(screen.getByTestId('effect-site-enabled'))
    expect(screen.getByTestId('effect-site-fu')).toHaveValue('0.5')
  })

  it('keeps blank and malformed text editable', async () => {
    const user = userEvent.setup()
    renderView()
    await enableEffectSite(user)
    await user.type(screen.getByTestId('effect-site-ke0'), 'abc')
    await user.click(runButton())
    // The invalid configuration is reported against the field (aria-invalid +
    // its described error node), and the text is still there.
    await waitFor(() => expect(screen.getByTestId('effect-site-ke0')).toHaveAttribute('aria-invalid', 'true'))
    const describedBy = screen.getByTestId('effect-site-ke0').getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    expect(document.getElementById(describedBy ?? '')?.textContent ?? '').toMatch(/finite number/i)
    expect(screen.getByTestId('effect-site-ke0')).toHaveValue('abc')
    // No simulation ran with an incomplete configuration.
    expect(control.calls).toBe(0)
  })

  it('does not run the simulation when an enabled configuration is incomplete', async () => {
    const user = userEvent.setup()
    renderView()
    await enableEffectSite(user)
    await user.click(runButton())
    expect(control.calls).toBe(0)
  })

  it('runs when configured and shows the effect-site and occupancy views', async () => {
    const user = userEvent.setup()
    renderView()
    await enableEffectSite(user)
    await user.type(screen.getByTestId('effect-site-fu'), '0.5')
    await user.type(screen.getByTestId('effect-site-ke0'), '2')
    await user.type(screen.getByTestId('effect-site-kd'), '2')
    await user.click(runButton())
    await waitFor(() => expect(control.calls).toBe(1))

    const group = await screen.findByRole('radiogroup', { name: 'Chart view' })
    const radios = within(group).getAllByRole('radio')
    expect(radios).toHaveLength(5)
    expect(within(group).getByRole('radio', { name: /effect site/i })).toBeInTheDocument()
    expect(within(group).getByRole('radio', { name: /occupancy/i })).toBeInTheDocument()
  })

  it('offers no effect-site views for a PK-only run', async () => {
    const user = userEvent.setup()
    renderView()
    await user.click(runButton())
    await waitFor(() => expect(control.calls).toBe(1))
    const group = await screen.findByRole('radiogroup', { name: 'Chart view' })
    expect(within(group).getAllByRole('radio')).toHaveLength(3)
    expect(within(group).queryByRole('radio', { name: /effect site/i })).not.toBeInTheDocument()
  })

  it('switching to the occupancy view is presentation-only', async () => {
    const user = userEvent.setup()
    renderView()
    await enableEffectSite(user)
    await user.type(screen.getByTestId('effect-site-fu'), '0.5')
    await user.type(screen.getByTestId('effect-site-ke0'), '2')
    await user.type(screen.getByTestId('effect-site-kd'), '2')
    await user.click(runButton())
    await waitFor(() => expect(control.calls).toBe(1))

    await user.click(screen.getByTestId('view-tab-occupancy'))
    expect(await screen.findByTestId('stub-chart-occupancy')).toBeInTheDocument()
    await user.click(screen.getByTestId('view-tab-effect-site'))
    expect(await screen.findByTestId('stub-chart-effect-site')).toBeInTheDocument()
    await user.click(screen.getByTestId('view-tab-concentration'))
    // No view change re-executed the engine.
    expect(control.calls).toBe(1)
  })

  it('invalidates a stale effect-site result after a relevant edit', async () => {
    const user = userEvent.setup()
    renderView()
    await enableEffectSite(user)
    await user.type(screen.getByTestId('effect-site-fu'), '0.5')
    await user.type(screen.getByTestId('effect-site-ke0'), '2')
    await user.type(screen.getByTestId('effect-site-kd'), '2')
    await user.click(runButton())
    await screen.findByTestId('stub-chart-concentration')

    await user.clear(screen.getByTestId('effect-site-ke0'))
    await user.type(screen.getByTestId('effect-site-ke0'), '3')
    await waitFor(() => expect(screen.queryByTestId('stub-chart-concentration')).not.toBeInTheDocument())
    expect(screen.getByTestId('simulation-idle')).toBeInTheDocument()
  })

  it('is keyboard operable', async () => {
    const user = userEvent.setup()
    renderView()
    const toggle = screen.getByTestId('effect-site-enabled')
    toggle.focus()
    expect(toggle).toHaveFocus()
    await user.keyboard('[Space]')
    expect(screen.getByTestId('effect-site-fu')).toBeInTheDocument()
  })
})
