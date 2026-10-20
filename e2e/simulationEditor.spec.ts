import { test, expect } from '@playwright/test'

/**
 * Scenario editor (phase 43).
 *
 * Edits the real form, runs the real engine and inspects Plotly's emitted
 * trace data. No network is intercepted because none is needed: the spec
 * asserts that no request leaves the page origin during the workflow.
 */
test.describe('simulation scenario editor', () => {
  test('edits, runs, toggles charts and resets to the synthetic example', async ({ page }) => {
    const externalRequests: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (
        !url.startsWith('http://localhost') &&
        !url.startsWith('http://127.0.0.1') &&
        !url.startsWith('data:') &&
        !url.startsWith('blob:')
      ) {
        externalRequests.push(url)
      }
    })

    // 1. Navigate through the application route.
    await page.goto('/simulation')
    await expect(page.getByRole('heading', { level: 1, name: 'Simulation' })).toBeVisible()
    await expect(page.getByTestId('synthetic-scenario-notice')).toContainText(/synthetic example/i)

    // 2. Edit one model parameter.
    const clearance = page.getByTestId('clearance-value')
    await clearance.fill('4')

    // 3. Add an IV bolus at a distinct time.
    await page.getByTestId('add-bolus').click()
    const newBolusRow = page.getByTestId('event-row-4')
    await expect(newBolusRow).toBeVisible()
    await page.getByTestId('bolus-4-time').fill('10')
    await page.getByTestId('bolus-4-amount').fill('20')

    // 4. Add an infusion session with start and stop times.
    await page.getByTestId('add-infusion').click()
    await expect(page.getByTestId('event-row-5')).toBeVisible()
    await page.getByTestId('infusion-5-start').fill('12')
    await page.getByTestId('infusion-5-stop').fill('14')
    await page.getByTestId('infusion-5-rate').fill('8')

    // 5. Change the output sampling interval.
    await page.getByTestId('output-interval-value').fill('0.5')

    // 6. Run the simulation.
    await page.getByTestId('run-simulation').click()
    const concentrationChart = page.getByTestId('simulation-chart-concentration')
    await expect(concentrationChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })

    // 7. The event list is exactly the edited scenario: two example events,
    // the added bolus and the added infusion (start + stop = six rows).
    const events = page.getByTestId('event-table')
    await expect(events).toContainText('IV bolus 100 mg')
    await expect(events).toContainText('10 mg/h')
    await expect(events).toContainText('IV bolus 20 mg')
    await expect(events).toContainText('8 mg/h')
    await expect(page.getByTestId('event-row-infusion-5-start')).toContainText('8 mg/h')
    await expect(page.getByTestId('event-row-infusion-5-stop')).toContainText(/no amount administered/i)
    // Seven applied events: two example boluses + the example infusion's
    // start and stop + the added bolus + the added infusion's start and stop.
    await expect(events.locator('tbody tr')).toHaveCount(7)

    // 8. The plots reflect the edited scenario: the added bolus at t = 10
    // jumps the central concentration by 20 mg / 10 L = 2 mg/L.
    const jump = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="simulation-chart-concentration"]')
      const graph = container?.querySelector('.js-plotly-plot') as
        | (Element & { data?: Array<{ name?: string; x?: number[]; y?: number[] }> })
        | null
      const trace = graph?.data?.find((t) => t.name === 'Central compartment')
      if (!trace?.x || !trace.y) return { error: 'no central trace' }
      const indices = trace.x.flatMap((x, i) => (Math.abs(x - 10) < 1e-9 ? [i] : []))
      return { indices, ys: indices.map((i) => trace.y?.[i]) }
    })
    expect(jump).not.toHaveProperty('error')
    if ('error' in jump) return
    expect(jump.indices).toHaveLength(2)
    const [pre, post] = jump.ys as [number, number]
    expect(post - pre).toBeCloseTo(2, 6)

    // 9. The infusion-rate chart shows the simulated schedule: 10 mg/h from
    // the example session and 8 mg/h from the added one.
    const rateChart = page.getByTestId('simulation-chart-infusion-rate')
    await expect(rateChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
    const rates = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="simulation-chart-infusion-rate"]')
      const graph = container?.querySelector('.js-plotly-plot') as
        | (Element & { data?: Array<{ x?: number[]; y?: number[] }> })
        | null
      const trace = graph?.data?.[0]
      if (!trace?.x || !trace.y) return { error: 'no rate trace' }
      return { x: trace.x, y: trace.y }
    })
    expect(rates).not.toHaveProperty('error')
    if ('error' in rates) return
    expect(Math.max(...(rates.y as number[]))).toBeCloseTo(10, 9)
    const at12Post = (rates.y as number[])[(rates.x as number[]).flatMap((x, i) => (x === 12 ? [i] : []))[1] ?? -1]
    expect(at12Post).toBeCloseTo(8, 9)

    // 10. Hide and restore the amount chart through its toggle.
    await expect(page.getByTestId('simulation-chart-amount')).toBeVisible()
    await page.getByTestId('toggle-amount').uncheck()
    await expect(page.getByTestId('simulation-chart-amount')).toHaveCount(0)
    await page.getByTestId('toggle-amount').check()
    await expect(page.getByTestId('simulation-chart-amount').locator('.js-plotly-plot')).toBeVisible({
      timeout: 30_000,
    })
    // Toggling never re-runs the simulation: the run label is unchanged.
    await expect(page.getByTestId('simulation-summary')).toContainText('Run 1')

    // 11. Reset restores the declared example values.
    await page.getByTestId('reset-demo').click()
    await expect(page.getByTestId('clearance-value')).toHaveValue('2')
    await expect(page.getByTestId('output-interval-value')).toHaveValue('0.25')
    await expect(page.getByTestId('bolus-1-amount')).toHaveValue('100')
    await expect(page.getByTestId('event-row-4')).toHaveCount(0)
    await expect(page.getByTestId('event-row-5')).toHaveCount(0)
    await expect(page.getByTestId('simulation-idle')).toBeVisible()

    // 12. No external network was needed for any of this.
    expect(externalRequests).toEqual([])
  })

  test('shows engine errors without drawing a curve', async ({ page }) => {
    await page.goto('/simulation')
    await page.getByTestId('central-volume-value').fill('0')
    await page.getByTestId('run-simulation').click()
    const errors = page.getByTestId('simulation-errors')
    await expect(errors).toContainText('ZERO_NOT_ALLOWED')
    await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
    // The error is attributed to the field it concerns.
    await expect(page.getByTestId('central-volume-value')).toHaveAttribute('aria-invalid', 'true')
  })
})
