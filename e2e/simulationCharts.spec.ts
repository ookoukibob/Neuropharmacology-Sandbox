import { test, expect, type Page } from '@playwright/test'

/**
 * Phase 44 — interactive simulation charts.
 *
 * Asserts real geometry and real interaction, not merely that an SVG exists:
 * the chart box matches its rendered graph (no overflow), nothing below is
 * overlapped, resizing re-lays out, zoom/reset works, view switching never
 * re-runs the engine, hover carries units, and the bolus discontinuity is
 * still two same-time samples.
 */

const chartBox = async (page: Page) =>
  page.evaluate(() => {
    const root = document.querySelector('[data-testid^="simulation-chart-"]') as HTMLElement | null
    if (!root) return null
    const plot = root.querySelector('.js-plotly-plot') as HTMLElement | null
    const figure = root.closest('figure') as HTMLElement | null
    const note = figure?.querySelector('p') ?? null
    const box = (el: Element | null) => {
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height), w: Math.round(r.width) }
    }
    return {
      id: root.dataset.testid ?? '',
      root: box(root),
      plot: box(plot),
      note: box(note),
      docWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }
  })

test.describe('simulation charts — layout and interaction', () => {
  test('chart fits its container and never overlaps the text below, at desktop and narrow widths', async ({ page }) => {
    for (const [width, label] of [
      [1280, 'desktop'],
      [420, 'narrow'],
    ] as const) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto('/simulation')
      await page.getByTestId('run-simulation').click()
      await expect(page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')).toBeVisible({
        timeout: 30_000,
      })
      await page.waitForTimeout(300)

      const box = await chartBox(page)
      expect(box, label).not.toBeNull()
      if (box === null) return
      // The rendered graph is exactly the height the container reserves: no
      // 450 px default spilling out of a 360 px box (the phase 44 defect).
      expect(box.plot?.h, label).toBe(box.root?.h)
      expect(box.plot?.top, label).toBe(box.root?.top)
      expect(box.plot?.w, label).toBe(box.root?.w)
      // The note below the chart starts after the chart ends.
      expect(box.note?.top ?? 0, label).toBeGreaterThanOrEqual(box.root?.bottom ?? 0)
      // No horizontal overflow of the page.
      expect(box.docWidth, label).toBe(box.viewportWidth)
    }
  })

  test('resizing the window re-lays the chart out', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto('/simulation')
    await page.getByTestId('run-simulation').click()
    await expect(page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')).toBeVisible({
      timeout: 30_000,
    })
    const wide = await chartBox(page)

    await page.setViewportSize({ width: 760, height: 900 })
    await expect
      .poll(async () => (await chartBox(page))?.plot?.w ?? 0, { timeout: 10_000 })
      .toBeLessThan(wide?.plot?.w ?? 0)

    const narrowBox = await chartBox(page)
    expect(narrowBox?.plot?.w).toBe(narrowBox?.root?.w)
    expect(narrowBox?.plot?.h).toBe(narrowBox?.root?.h)
  })

  test('view switching changes the chart without re-running the simulation', async ({ page }) => {
    await page.goto('/simulation')
    await page.getByTestId('run-simulation').click()
    await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('simulation-summary')).toContainText('Run 1')

    await page.getByTestId('view-tab-amount').click()
    await expect(page.getByTestId('simulation-chart-amount')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('simulation-chart-concentration')).toHaveCount(0)

    await page.getByTestId('view-tab-infusion-rate').click()
    await expect(page.getByTestId('simulation-chart-infusion-rate')).toBeVisible({ timeout: 30_000 })

    await page.getByTestId('view-tab-concentration').click()
    await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
    // Still the same run: no second simulation was performed.
    await expect(page.getByTestId('simulation-summary')).toContainText('Run 1')
    // The event table stays available beside every view.
    await expect(page.getByTestId('event-table')).toBeVisible()
  })

  test('zoom and reset return the axis to the full simulation range', async ({ page }) => {
    await page.goto('/simulation')
    await page.getByTestId('run-simulation').click()
    const plot = page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')
    await expect(plot).toBeVisible({ timeout: 30_000 })

    // Drag across the plot to zoom into a sub-range.
    const box = await plot.boundingBox()
    expect(box).not.toBeNull()
    if (box === null) return
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7, { steps: 8 })
    await page.mouse.up()
    await page.waitForTimeout(300)

    const zoomed = await page.evaluate(() => {
      const gd = document.querySelector('[data-testid="simulation-chart-concentration"] .js-plotly-plot') as
        | (Element & { layout?: { xaxis?: { range?: number[] } } })
        | null
      return gd?.layout?.xaxis?.range ?? null
    })
    expect(zoomed).not.toBeNull()
    expect(zoomed?.[0]).toBeGreaterThan(0)

    // Double-click resets to the full range.
    await plot.dblclick({ position: { x: box.width / 2, y: box.height / 2 } })
    await page.waitForTimeout(400)
    const reset = await page.evaluate(() => {
      const gd = document.querySelector('[data-testid="simulation-chart-concentration"] .js-plotly-plot') as
        | (Element & { layout?: { xaxis?: { range?: number[]; autorange?: boolean } } })
        | null
      return { range: gd?.layout?.xaxis?.range ?? null, autorange: gd?.layout?.xaxis?.autorange }
    })
    // Reset restores the full 0–24 h domain.
    const [r0, r1] = (reset.range ?? [0, 24]) as [number, number]
    expect(r0).toBeLessThanOrEqual(0.5)
    expect(r1).toBeGreaterThanOrEqual(23.5)
  })

  test('hover text carries the value, the unit and the event side', async ({ page }) => {
    await page.goto('/simulation')
    await page.getByTestId('run-simulation').click()
    const plot = page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')
    await expect(plot).toBeVisible({ timeout: 30_000 })
    // Per-point hover text is provided by the adapter for every sample.
    const hover = await page.evaluate(() => {
      const gd = document.querySelector('[data-testid="simulation-chart-concentration"] .js-plotly-plot') as
        | (Element & { data?: Array<{ customdata?: string[] }> })
        | null
      return gd?.data?.[0]?.customdata ?? []
    })
    expect(hover.length).toBeGreaterThan(0)
    expect(hover[0]).toContain('mg/L')
    expect(hover[0]).toContain('t =')
    expect(hover.join(' ')).toContain('just before the event')
    expect(hover.join(' ')).toContain('just after the event')
  })

  test('the bolus remains two same-time samples in the plotted trace', async ({ page }) => {
    await page.goto('/simulation')
    await page.getByTestId('run-simulation').click()
    await expect(page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')).toBeVisible({
      timeout: 30_000,
    })
    const jump = await page.evaluate(() => {
      const gd = document.querySelector('[data-testid="simulation-chart-concentration"] .js-plotly-plot') as
        | (Element & { data?: Array<{ name?: string; x?: number[]; y?: number[] }> })
        | null
      const trace = gd?.data?.find((t) => t.name === 'Central compartment')
      if (!trace?.x || !trace.y) return null
      const at8 = trace.x.flatMap((x, i) => (Math.abs(x - 8) < 1e-9 ? [i] : []))
      return { count: at8.length, ys: at8.map((i) => trace.y?.[i]) }
    })
    expect(jump?.count).toBe(2)
    // 30 mg / 10 L = 3 mg/L instantaneously at t = 8 h.
    const [pre, post] = (jump?.ys ?? [0, 0]) as [number, number]
    expect(post - pre).toBeCloseTo(3, 6)
  })

  test('infusion-rate view keeps the engine step values and the unavailable state', async ({ page }) => {
    await page.goto('/simulation')
    await page.getByTestId('run-simulation').click()
    await page.getByTestId('view-tab-infusion-rate').click()
    const plot = page.getByTestId('simulation-chart-infusion-rate').locator('.js-plotly-plot')
    await expect(plot).toBeVisible({ timeout: 30_000 })
    const steps = await page.evaluate(() => {
      const gd = document.querySelector('[data-testid="simulation-chart-infusion-rate"] .js-plotly-plot') as
        | (Element & { data?: Array<{ x?: number[]; y?: number[]; customdata?: string[] }> })
        | null
      const trace = gd?.data?.[0]
      return { x: trace?.x ?? [], y: trace?.y ?? [], hover: trace?.customdata ?? [] }
    })
    expect(Math.max(...steps.y)).toBe(10)
    // Coincident pre/post samples at the start (2 h) and the stop (6 h).
    expect(steps.x.filter((x) => x === 2)).toHaveLength(2)
    expect(steps.x.filter((x) => x === 6)).toHaveLength(2)
    expect(steps.hover.join(' ')).toContain('active: infusion-3')

    // Without an infusion the view is unavailable and no rate chart is drawn.
    await page.getByTestId('view-tab-concentration').click()
    await page.getByTestId('remove-event-3').click()
    await page.getByTestId('run-simulation').click()
    await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
    await expect(page.getByTestId('view-tab-infusion-rate')).toBeDisabled()
    await expect(page.getByTestId('simulation-chart-infusion-rate')).toHaveCount(0)
  })

  test('the view switcher is operable with the keyboard', async ({ page }) => {
    await page.goto('/simulation')
    await page.getByTestId('run-simulation').click()
    await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-tab-concentration').focus()
    await expect(page.getByTestId('view-tab-concentration')).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('view-tab-amount')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('simulation-chart-amount')).toBeVisible({ timeout: 30_000 })
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('view-tab-concentration')).toHaveAttribute('aria-checked', 'true')
  })
})
