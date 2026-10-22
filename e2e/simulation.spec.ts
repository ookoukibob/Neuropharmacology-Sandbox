import { test, expect } from '@playwright/test'

/**
 * Simulation engine and chart integration smoke test.
 *
 * Drives the real route → real engine → real Plotly chart. No network is
 * intercepted because the simulation needs none: the spec asserts that no
 * request leaves the page origin while the entered scenario runs, and that the
 * result survives a reload only as "nothing was saved" (ephemeral state).
 */
test.describe('simulation integration', () => {
  test('runs an explicitly entered scenario and preserves the bolus discontinuity', async ({ page }) => {
    const externalRequests: string[] = []
    page.on('request', (request) => {
      const url = request.url()
      if (!url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1') && !url.startsWith('data:')) {
        externalRequests.push(url)
      }
    })

    // 1. Navigate through the actual application route.
    await page.goto('/simulation')
    await expect(page.getByRole('heading', { level: 1, name: 'Simulation' })).toBeVisible()

    // 2. The editor starts empty. Enter a deterministic test scenario
    // explicitly; these values live in the E2E fixture, not in product defaults.
    await expect(page.getByTestId('synthetic-scenario-notice')).toHaveCount(0)
    await expect(page.getByTestId('central-volume-value')).toHaveValue('')
    await expect(page.getByTestId('no-events')).toBeVisible()
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
    await expect(page.getByTestId('simulation-idle')).toBeVisible()

    // 3. Run the manually entered test scenario with the keyboard (into the form's submit).
    const runButton = page.getByTestId('run-simulation')
    await runButton.focus()
    await expect(runButton).toBeFocused()
    await page.keyboard.press('Enter')

    // 4. The concentration view appears; the amount view renders the same
    // data in its own units (one analysis view at a time since phase 44).
    const concentrationChart = page.getByTestId('simulation-chart-concentration')
    await expect(concentrationChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-tab-amount').click()
    const amountChart = page.getByTestId('simulation-chart-amount')
    await expect(amountChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-tab-concentration').click()
    await expect(concentrationChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })

    // 5. The event list contains the bolus and infusion events.
    const events = page.getByTestId('event-table')
    // The example compiles to four engine events from three editor rows:
    // bolus 1, bolus 2, infusion 3 start and infusion 3 stop.
    for (const id of ['bolus-1', 'bolus-2', 'infusion-3-start', 'infusion-3-stop']) {
      await expect(page.getByTestId(`event-row-${id}`)).toBeVisible()
    }
    // The visible content names the doses, rates and the infusion identity.
    await expect(page.getByTestId('event-row-bolus-1')).toContainText('IV bolus 100 mg')
    await expect(page.getByTestId('event-row-infusion-3-start')).toContainText('10 mg/h')
    await expect(page.getByTestId('event-row-bolus-2')).toContainText('IV bolus 30 mg')
    // A stop is never presented as an administered amount.
    await expect(page.getByTestId('event-row-infusion-3-stop')).toContainText(
      /no amount administered/i,
    )
    await expect(events).toContainText('infusion-3')

    // 6. The underlying central-concentration trace keeps the bolus jump:
    // two consecutive points at t = 8 h whose values differ by 30 mg / 10 L.
    const jump = await page.evaluate(() => {
      const container = document.querySelector('[data-testid="simulation-chart-concentration"]')
      const graph = container?.querySelector('.js-plotly-plot') as
        | (Element & { data?: Array<{ name?: string; x?: number[]; y?: number[] }> })
        | null
      const trace = graph?.data?.find((t) => t.name === 'Central compartment')
      if (!trace?.x || !trace.y) return { error: 'no central trace' }
      const indices = trace.x.flatMap((x, i) => (Math.abs(x - 8) < 1e-9 ? [i] : []))
      return {
        indices,
        xs: indices.map((i) => trace.x?.[i]),
        ys: indices.map((i) => trace.y?.[i]),
        firstX: trace.x[0],
        firstY: trace.y[0],
      }
    })
    expect(jump).not.toHaveProperty('error')
    if ('error' in jump) return
    expect(jump.indices).toHaveLength(2)
    const [pre, post] = jump.ys as [number, number]
    expect(post - pre).toBeCloseTo(3, 6) // 30 mg / 10 L = 3 mg/L within reporting precision
    expect(jump.xs?.[0]).toBe(jump.xs?.[1])
    // The very first point is the start of the simulation (before the t = 0 bolus).
    expect(jump.firstX).toBe(0)
    expect(jump.firstY).toBe(0)

    // 7. Mass-balance diagnostics are shown for a successful run.
    const massBalance = page.getByTestId('mass-balance-diagnostics')
    await expect(massBalance).toContainText(/within tolerance/i)
    await expect(massBalance).toContainText(/acceptance tolerance/i)
    await expect(page.getByTestId('solver-diagnostics')).toContainText(/derivative evaluations/i)
    await expect(page.getByTestId('qualification-note')).toContainText(/does not mean/i)

    // 8. No external network request was needed for the simulation.
    expect(externalRequests).toEqual([])

    // Ephemeral: a reload returns to an empty editor and no result (nothing was saved).
    await page.reload()
    await expect(page.getByTestId('simulation-idle')).toBeVisible()
    await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
    await expect(page.getByTestId('central-volume-value')).toHaveValue('')
  })
})