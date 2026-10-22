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

/** Explicit UI test fixture; product pages start with blank scientific inputs. */
async function fillSyntheticScenario(page: Page): Promise<void> {
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
}

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
      await fillSyntheticScenario(page)
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
      await fillSyntheticScenario(page)
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
      await fillSyntheticScenario(page)
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
      await fillSyntheticScenario(page)
    await page.getByTestId('run-simulation').click()
    const plot = page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')
    await expect(plot).toBeVisible({ timeout: 30_000 })

    const axisRange = async (): Promise<[number, number]> =>
      page.evaluate(() => {
        const gd = document.querySelector('[data-testid="simulation-chart-concentration"] .js-plotly-plot') as
          | (Element & { layout?: { xaxis?: { range?: [number, number]; autorange?: boolean | 'reversed' } } })
          | null
        const axis = gd?.layout?.xaxis
        if (axis === undefined) throw new Error('no xaxis on the graph')
        if (axis.range !== undefined) return axis.range
        if (axis.autorange === true) throw new Error('xaxis is autoranged without an explicit range')
        throw new Error('no observable x axis range')
      })

    // The full range covers the simulation horizon 0–24 h (Plotly pads the
    // axis by a fraction of a percent, so assert the span, not the padding).
    const full = await axisRange()
    expect(full[0]).toBeLessThan(0)
    expect(full[0]).toBeGreaterThan(-0.2)
    expect(full[1]).toBeCloseTo(24, 6)
    expect(full[1] - full[0]).toBeGreaterThan(23.8)

    // Drag across the plot area to zoom into a strict sub-range.
    const box = await plot.boundingBox()
    expect(box).not.toBeNull()
    if (box === null) return
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.35)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.65, { steps: 8 })
    await page.mouse.up()

    // Wait for a real zoom: the range must be observably narrower than the
    // full horizon on both sides (no fallback if the range is missing).
    await expect
      .poll(async () => {
        const range = await axisRange().catch(() => null)
        return range === null ? 'missing' : range[1] - range[0]
      }, { timeout: 10_000 })
      .toBeLessThan(23)
    const zoomed = await axisRange()
    expect(zoomed[0]).toBeGreaterThan(1)
    expect(zoomed[1]).toBeLessThan(23)

    // Double-click resets to the full simulation range.
    await plot.dblclick({ position: { x: box.width / 2, y: box.height / 2 } })
    await expect
      .poll(async () => {
        const range = await axisRange().catch(() => null)
        if (range === null) return false
        // Back to the FULL range: both ends match the initial full range.
        return Math.abs(range[0] - full[0]) < 0.05 && Math.abs(range[1] - full[1]) < 0.05
      }, { timeout: 10_000 })
      .toBe(true)
    const reset = await axisRange()
    expect(reset[0]).toBeCloseTo(full[0], 3)
    expect(reset[1]).toBeCloseTo(full[1], 3)
    expect(reset[1] - reset[0]).toBeGreaterThan(23.8)
  })

  test('hovering a plotted point shows time, value, unit and event side', async ({ page }) => {
    await page.goto('/simulation')
      await fillSyntheticScenario(page)
    await page.getByTestId('run-simulation').click()
    const plot = page.getByTestId('simulation-chart-concentration').locator('.js-plotly-plot')
    await expect(plot).toBeVisible({ timeout: 30_000 })

    // Aim at a real plotted point: the central-compartment value at t = 1 h.
    const target = await page.evaluate(() => {
      const root = document.querySelector('[data-testid="simulation-chart-concentration"]') as HTMLElement
      const gd = root.querySelector('.js-plotly-plot') as
        | (Element & {
            data?: Array<{ name?: string; x?: number[]; y?: number[] }>
            _fullLayout?: {
              xaxis: { _offset: number; _length: number; range: [number, number] }
              yaxis: { _offset: number; _length: number; range: [number, number] }
            }
          })
        | null
      const trace = gd?.data?.find((t) => t.name === 'Central compartment')
      const fl = gd?._fullLayout
      const box = root.getBoundingClientRect()
      const index = trace?.x?.findIndex((x) => Math.abs(x - 1) < 1e-9) ?? -1
      if (!trace?.x || !trace.y || !fl || index < 0) return null
      const x = trace.x[index] as number
      const y = trace.y[index] as number
      const [x0, x1] = fl.xaxis.range
      const [y0, y1] = fl.yaxis.range
      const px = box.left + fl.xaxis._offset + ((x - x0) / (x1 - x0)) * fl.xaxis._length
      const py = box.top + fl.yaxis._offset + ((y1 - y) / (y1 - y0)) * fl.yaxis._length
      return { px, py, x, y }
    })
    expect(target).not.toBeNull()
    if (target === null) return
    expect(target.x).toBeCloseTo(1, 6)

    await page.mouse.move(target.px, target.py)
    await page.mouse.move(target.px + 1, target.py + 1, { steps: 4 })

    // The rendered hover label (not merely the trace's customdata) must show
    // the time, the numeric value, the unit and the sample's event side.
    const label = page.locator('[data-testid="simulation-chart-concentration"] .js-plotly-plot .hovertext')
    await expect(label).toHaveCount(1, { timeout: 10_000 })
    await expect(label).toBeVisible()
    const text = ((await label.textContent()) ?? '').replace(/\s+/g, ' ')
    expect(text).toContain('t = 1 h')
    expect(text).toContain('mg/L')
    expect(text).toContain('between events')
    // The plotted value itself is shown (adapter formatting, 6 significant digits).
    expect(text).toContain(String(Number(target.y.toPrecision(6))))
    // And it names the series it belongs to.
    expect(text).toContain('Central compartment')
  })

  test('the bolus remains two same-time samples in the plotted trace', async ({ page }) => {
    await page.goto('/simulation')
      await fillSyntheticScenario(page)
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
      await fillSyntheticScenario(page)
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
      await fillSyntheticScenario(page)
    await page.getByTestId('run-simulation').click()
    await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
    await page.getByTestId('view-tab-concentration').focus()
    await expect(page.getByTestId('view-tab-concentration')).toBeFocused()
    // ArrowRight: checked state, rendered chart AND DOM focus move together.
    await page.keyboard.press('ArrowRight')
    await expect(page.getByTestId('view-tab-amount')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('view-tab-amount')).toBeFocused()
    await expect(page.getByTestId('simulation-chart-amount')).toBeVisible({ timeout: 30_000 })

    // Tab enters the group at the selected option, not the first one.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
    await page.getByTestId('view-tab-amount').focus()
    await page.keyboard.press('Tab')
    await page.keyboard.press('Shift+Tab')
    await expect(page.getByTestId('view-tab-amount')).toBeFocused()

    // ArrowLeft reverses: focus and selection return to concentration.
    await page.keyboard.press('ArrowLeft')
    await expect(page.getByTestId('view-tab-concentration')).toHaveAttribute('aria-checked', 'true')
    await expect(page.getByTestId('view-tab-concentration')).toBeFocused()
    await expect(page.getByTestId('simulation-chart-concentration')).toBeVisible({ timeout: 30_000 })
  })
})