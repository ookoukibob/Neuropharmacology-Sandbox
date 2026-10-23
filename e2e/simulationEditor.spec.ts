import { test, expect } from '@playwright/test'

/**
 * Scenario editor (phase 43).
 *
 * Edits the real form, runs the real engine and inspects Plotly's emitted
 * trace data. No network is intercepted because none is needed: the spec
 * asserts that no request leaves the page origin during the workflow.
 */
test.describe('simulation scenario editor', () => {
  test('edits a blank scenario, runs, toggles charts and clears it', async ({ page }) => {
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
    await expect(page.getByTestId('synthetic-scenario-notice')).toHaveCount(0)
    await expect(page.getByTestId('central-volume-value')).toHaveValue('')

    // 2. Enter the explicit baseline inputs required by this test.
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
      await page.getByTestId(testId).fill(value)
    }
    await page.getByTestId('add-bolus').click()
    await page.getByTestId('bolus-1-time').fill('0')
    await page.getByTestId('bolus-1-amount').fill('100')
    await page.getByTestId('add-bolus').click()
    await page.getByTestId('bolus-2-time').fill('8')
    await page.getByTestId('bolus-2-amount').fill('30')
    await page.getByTestId('add-infusion').click()
    await page.getByTestId('infusion-3-start').fill('2')
    await page.getByTestId('infusion-3-stop').fill('6')
    await page.getByTestId('infusion-3-rate').fill('10')

    // 3. Edit one model parameter.
    const clearance = page.getByTestId('clearance-value')
    await clearance.fill('4')

    // 4. Add an IV bolus at a distinct time.
    await page.getByTestId('add-bolus').click()
    const newBolusRow = page.getByTestId('event-row-4')
    await expect(newBolusRow).toBeVisible()
    await page.getByTestId('bolus-4-time').fill('10')
    await page.getByTestId('bolus-4-amount').fill('20')

    // 5. Add an infusion session with start and stop times.
    await page.getByTestId('add-infusion').click()
    await expect(page.getByTestId('event-row-5')).toBeVisible()
    await page.getByTestId('infusion-5-start').fill('12')
    await page.getByTestId('infusion-5-stop').fill('14')
    await page.getByTestId('infusion-5-rate').fill('8')

    // 6. Change the output sampling interval.
    await page.getByTestId('output-interval-value').fill('0.5')

    // 7. Run the simulation.
    await page.getByTestId('run-simulation').click()
    const concentrationChart = page.getByTestId('simulation-chart-concentration')
    await expect(concentrationChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })

    // 8. The event list is exactly the entered scenario: three baseline events,
    // the added bolus and the added infusion (start + stop = seven rows).
    const events = page.getByTestId('event-table')
    await expect(events).toContainText('IV bolus 100 mg')
    await expect(events).toContainText('10 mg/h')
    await expect(events).toContainText('IV bolus 20 mg')
    await expect(events).toContainText('8 mg/h')
    await expect(page.getByTestId('event-row-infusion-5-start')).toContainText('8 mg/h')
    await expect(page.getByTestId('event-row-infusion-5-stop')).toContainText(/no amount administered/i)
    // Seven applied events: two boluses + the baseline infusion's start/stop,
    // the added bolus + the added infusion's start/stop.
    await expect(events.locator('tbody tr')).toHaveCount(7)

    // 9. The plots reflect the edited scenario: the added bolus at t = 10
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

    // 10. The infusion-rate view shows the simulated schedule: 10 mg/h from
    // the entered session and 8 mg/h from the added one.
    await page.getByTestId('view-tab-infusion-rate').click()
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

    // 11. Switching views shows the amount chart and never re-runs the
    // simulation: the run label is unchanged.
    await page.getByTestId('view-tab-amount').click()
    await expect(page.getByTestId('simulation-chart-amount').locator('.js-plotly-plot')).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
    await page.getByTestId('view-tab-concentration').click()
    await expect(page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')).toBeVisible({
      timeout: 30_000,
    })
    await expect(page.getByTestId('simulation-summary')).toContainText('Run 1')

    // 12. Clear returns to the blank editor and invalidates the result.
    await page.getByTestId('clear-scenario').click()
    await expect(page.getByTestId('clearance-value')).toHaveValue('')
    await expect(page.getByTestId('output-interval-value')).toHaveValue('')
    await expect(page.getByTestId('event-row-1')).toHaveCount(0)
    await expect(page.getByTestId('event-row-2')).toHaveCount(0)
    await expect(page.getByTestId('event-row-3')).toHaveCount(0)
    await expect(page.getByTestId('simulation-idle')).toBeVisible()

    // 13. No external network was needed for any of this.
    expect(externalRequests).toEqual([])
  })

  test('shows engine errors without drawing a curve', async ({ page }) => {
    await page.goto('/simulation')
    for (const [testId, value] of [
      ['central-volume-value', '0'],
      ['peripheral-volume-value', '20'],
      ['clearance-value', '2'],
      ['q-value', '3'],
      ['initial-central-value', '0'],
      ['initial-peripheral-value', '0'],
      ['start-time-value', '0'],
      ['end-time-value', '24'],
      ['output-interval-value', '0.25'],
    ] as const) {
      await page.getByTestId(testId).fill(value)
    }
    await page.getByTestId('run-simulation').click()
    const errors = page.getByTestId('simulation-errors')
    await expect(errors).toContainText('ZERO_NOT_ALLOWED')
    await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
    // The error is attributed to the field it concerns.
    await expect(page.getByTestId('central-volume-value')).toHaveAttribute('aria-invalid', 'true')
  })

  test('expands a repeated dose into the schedule preview and runs it', async ({ page }) => {
    await page.goto('/simulation')
    for (const [testId, value] of [
      ['central-volume-value', '10'],
      ['peripheral-volume-value', '20'],
      ['clearance-value', '2'],
      ['q-value', '0'],
      ['initial-central-value', '0'],
      ['initial-peripheral-value', '0'],
      ['start-time-value', '0'],
      ['end-time-value', '24'],
      ['output-interval-value', '1'],
    ] as const) {
      await page.getByTestId(testId).fill(value)
    }
    await page.getByTestId('add-bolus').click()
    await page.getByTestId('bolus-1-time').fill('2')
    await page.getByTestId('bolus-1-amount').fill('10')
    await page.getByTestId('repeat-1-count').fill('3')
    await page.getByTestId('repeat-1-interval').fill('6')

    // The expanded schedule preview lists three doses at 2, 8 and 14 h.
    await expect(page.getByTestId('expanded-dose-1-1')).toContainText('2')
    await expect(page.getByTestId('expanded-dose-1-2')).toContainText('8')
    await expect(page.getByTestId('expanded-dose-1-3')).toContainText('14')

    // Running applies all three bolus events.
    await page.getByTestId('run-simulation').click()
    await expect(
      page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot'),
    ).toBeVisible({ timeout: 30_000 })
    const events = page.getByTestId('event-table')
    await expect(events).toContainText('IV bolus 10 mg')
    await expect(events.locator('tbody tr')).toHaveCount(3)
  })
})