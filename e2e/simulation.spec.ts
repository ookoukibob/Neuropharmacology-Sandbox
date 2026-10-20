import { test, expect } from '@playwright/test'

/**
 * Simulation demonstration (phase 42).
 *
 * Drives the real route → real engine → real Plotly chart. No network is
 * intercepted because the simulation needs none: the spec asserts that no
 * request leaves the page origin while the demonstration runs, and that the
 * result survives a reload only as "nothing was saved" (ephemeral state).
 */
test.describe('simulation demonstration', () => {
  test('runs the synthetic demonstration and preserves the bolus discontinuity', async ({ page }) => {
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

    // 2. Synthetic disclaimer and visible parameters.
    const notice = page.getByTestId('synthetic-scenario-notice')
    await expect(notice).toContainText(/synthetic demonstration scenario/i)
    await expect(notice).toContainText(/not real compound parameters/i)
    const parameters = page.getByTestId('scenario-parameters')
    await expect(parameters).toContainText('10 L')
    await expect(parameters).toContainText('2 L/h')
    await expect(parameters).toContainText('100 mg at t = 0 h')
    await expect(parameters).toContainText('10 mg/h from t = 2 h to t = 6 h')
    await expect(parameters).toContainText('30 mg at t = 8 h')
    await expect(page.getByTestId('simulation-idle')).toBeVisible()

    // 3. Run the demonstration with the keyboard (also proves keyboard reach).
    const runButton = page.getByTestId('run-demonstration')
    await runButton.focus()
    await expect(runButton).toBeFocused()
    await page.keyboard.press('Enter')

    // 4. Both plots appear (Plotly renders an SVG per chart).
    const concentrationChart = page.getByTestId('simulation-chart-concentration')
    const amountChart = page.getByTestId('simulation-chart-amount')
    await expect(concentrationChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })
    await expect(amountChart.locator('.js-plotly-plot')).toBeVisible({ timeout: 30_000 })

    // 5. The event list contains the bolus and infusion events.
    const events = page.getByTestId('event-table')
    // Four events, each with its own row (matched by stable row id).
    for (const id of [
      'demo-bolus-1',
      'demo-infusion-start-1',
      'demo-infusion-stop-1',
      'demo-bolus-2',
    ]) {
      await expect(page.getByTestId(`event-row-${id}`)).toBeVisible()
    }
    // The visible content names the doses, rates and the infusion identity.
    await expect(page.getByTestId('event-row-demo-bolus-1')).toContainText('IV bolus 100 mg')
    await expect(page.getByTestId('event-row-demo-infusion-start-1')).toContainText('10 mg/h')
    await expect(page.getByTestId('event-row-demo-bolus-2')).toContainText('IV bolus 30 mg')
    // A stop is never presented as an administered amount.
    await expect(page.getByTestId('event-row-demo-infusion-stop-1')).toContainText(
      /no amount administered/i,
    )
    await expect(events).toContainText('demo-infusion-1')

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

    // 8. No external network request was needed for the demonstration.
    expect(externalRequests).toEqual([])

    // Ephemeral: a reload starts from the idle state again (nothing saved).
    await page.reload()
    await expect(page.getByTestId('simulation-idle')).toBeVisible()
    await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)
  })
})
