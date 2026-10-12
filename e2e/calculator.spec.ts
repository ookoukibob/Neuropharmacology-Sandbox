import { expect, test, type Page } from '@playwright/test'

/**
 * Critical calculator workflows (phase 4 closure pass).
 *
 * A  occupancy calculation: result, formula, calculation trace
 * B  PK parameterization switching (regression for the discriminated-union bug)
 * C  drug record → calculator with provenance, explicit candidate loading only
 * D  stale-state semantics (input edits and library loads mark stale)
 * E  curve workflow: explicit range → chart, settings-stale indication
 * F  blank-input curve validation (phase 27): a cleared input blocks both
 *    the "Update curve" action and the automatic scale-change re-apply
 *    with the schema message — never a silent zero curve
 *
 * Every value used here is synthetic. Records created by these tests are
 * tagged `synthetic-fixture` and carry an explicit note — no real
 * pharmacological parameter is ever introduced to make a test convenient.
 */

/**
 * Create a synthetic drug record through the real UI (library → new →
 * target → Kd parameter → save) and land on its detail page.
 */
async function createSyntheticDrug(
  page: Page,
  name: string,
  targetName: string,
  kd: string,
): Promise<void> {
  await page.goto('/library')
  await page.getByTestId('new-drug').click()
  await expect(page.getByRole('heading', { name: 'New Drug Record' })).toBeVisible()

  await page.getByTestId('drug-name').fill(name)
  await page.locator('#drug-tags').fill('synthetic-fixture')
  await page
    .locator('#drug-notes')
    .fill('Synthetic record created by end-to-end tests — not pharmacological information.')

  await page.getByTestId('add-target').click()
  await page.locator('#target-name-1').fill(targetName)
  await page.getByTestId('add-param').click()
  await page.locator('#param-kind-1-0').selectOption('kd')
  await page.locator('#param-value-1-0').fill(kd)
  await page.locator('#param-unit-1-0').selectOption('nM')

  await page.getByTestId('save-drug').click()
  await expect(page.getByRole('heading', { name: 'Drug Detail' })).toBeVisible()
  await expect(page.getByTestId('param-Kd')).toContainText(`${kd} nM`)
}

/** Fill the occupancy model with synthetic [D] and Kd values (units in nM). */
async function fillOccupancy(page: Page, concentration: string, kd: string): Promise<void> {
  await page.getByTestId('input-concentration-value').fill(concentration)
  await page.getByTestId('input-concentration-unit').selectOption('nM')
  await page.getByTestId('input-kd-value').fill(kd)
  await page.getByTestId('input-kd-unit').selectOption('nM')
}

/**
 * Fill the first-order PK model with synthetic values (C0 in µM, t and t½
 * in h). The µM symbol is the literal U+00B5 micro sign — the canonical
 * symbol the unit catalog normalizes to (verified by codepoint).
 */
async function fillPK(page: Page, c0: string, time: string, halfLife: string): Promise<void> {
  await page.getByTestId('input-c0-value').fill(c0)
  await page.getByTestId('input-c0-unit').selectOption('µM')
  await page.getByTestId('input-time-value').fill(time)
  await page.getByTestId('input-time-unit').selectOption('h')
  await page.getByTestId('input-halfLife-value').fill(halfLife)
  await page.getByTestId('input-halfLife-unit').selectOption('h')
}

/**
 * Assert that Plotly has actually rendered the expected curve with visible
 * SVG path geometry, not merely that trace data exists in memory.
 *
 * This helper verifies:
 * 1. The Plotly graph container exists and has initialized (gd.data present).
 * 2. A scatter trace line path with non-empty geometry has been drawn
 *    (path.js-line with d attribute of substantial length).
 * 3. The trace's endpoint data matches the expected values within tolerance.
 *
 * Used instead of hover labels because plotly hover is not reliably bound
 * in the dev-server e2e environment.
 */
async function expectRenderedCurveEndpoints(
  page: Page,
  expected: { x0: number; xLast: number; y0: number; yLast: number },
): Promise<void> {
  const drawn = await page.evaluate(() => {
    const chartContainer = document.querySelector('[data-testid="curve-chart"]')
    if (!chartContainer) return { error: 'No chart container found' }

    const gd = chartContainer.querySelector('.js-plotly-plot') as
      | (Element & { data?: Array<{ x?: number[]; y?: number[] }> })
      | null
    if (!gd) return { error: 'No .js-plotly-plot found' }

    const trace = gd.data?.[0]
    if (!trace?.x || !trace.y || trace.x.length === 0) {
      return { error: 'No trace data in gd.data[0]' }
    }

    // Verify actual rendered line path exists with non-empty geometry.
    // For line traces (mode: 'lines'), Plotly renders a path.js-line with
    // a d attribute containing the SVG path commands.
    const linePath = chartContainer.querySelector('.scatterlayer .trace path.js-line')
    if (!linePath) return { error: 'No rendered line path found (.scatterlayer .trace path.js-line)' }

    const dAttr = linePath.getAttribute('d')
    if (!dAttr || dAttr.length < 10) {
      return {
        error: 'Line path has no substantial geometry',
        dLength: dAttr?.length || 0,
      }
    }

    return {
      x0: trace.x[0],
      xLast: trace.x[trace.x.length - 1],
      y0: trace.y[0],
      yLast: trace.y[trace.y.length - 1],
      pathRendered: true,
      pathLength: dAttr.length,
    }
  })

  // Assert no errors occurred
  expect(drawn).not.toHaveProperty('error')
  expect(drawn).toHaveProperty('pathRendered', true)
  expect(drawn).toHaveProperty('pathLength')
  // Path length > 100 indicates a real curve was drawn (not just a stub)
  if (typeof drawn === 'object' && 'pathLength' in drawn) {
    expect(drawn.pathLength).toBeGreaterThan(100)
  }

  // Assert endpoint values match expectations
  if (typeof drawn === 'object' && 'x0' in drawn) {
    expect(drawn.x0).toBe(expected.x0)
    expect(drawn.xLast).toBe(expected.xLast)
    expect(drawn.y0).toBe(expected.y0)
    expect(drawn.yLast).toBeCloseTo(expected.yLast, 10)
  }
}

test('occupancy: calculates [D]/([D]+Kd) and shows result, formula and trace', async ({
  page,
}) => {
  await page.goto('/calculator')
  await expect(page.getByTestId('calculator-view')).toBeVisible()
  await page.getByTestId('model-select').selectOption('occupancy.single-site')

  // Synthetic inputs: [D] = 10 nM, Kd = 10 nM → fractional occupancy 0.5.
  await fillOccupancy(page, '10', '10')
  await page.getByTestId('calculate-btn').click()

  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('calculation-errors')).toBeHidden()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('0.5')
  await expect(page.getByTestId('result-outputs')).toContainText('50')
  await expect(page.getByTestId('result-formula')).toContainText(
    'Occupancy = [D] / ([D] + Kd)',
  )
  await expect(page.getByTestId('result-inputs')).toContainText('10 nM')

  // Structured calculation trace with at least one step.
  await expect(page.getByTestId('calculation-trace')).toBeVisible()
  await expect(page.getByTestId(/^trace-step-/).first()).toBeVisible()

  // Typed values make an explicit "no source claim".
  await expect(page.getByTestId('source-concentration')).toContainText(
    'no source claim',
  )
  await expect(page.getByTestId('source-kd')).toContainText('no source claim')
})

test('pk: half-life ↔ rate-constant switching preserves inputs and recalculates', async ({
  page,
}) => {
  await page.goto('/calculator')
  await page.getByTestId('model-select').selectOption('pk.first-order-one-compartment')

  // Half-life parameterization is active; k has no field at all.
  await expect(page.getByTestId('pk-mode-toggle')).toBeVisible()
  await expect(page.getByTestId('pk-mode-halfLife')).toHaveAttribute(
    'aria-checked',
    'true',
  )
  await expect(page.getByTestId('field-halfLife')).toBeVisible()
  await expect(page.getByTestId('field-k')).toBeHidden()

  // Synthetic inputs: C0 = 100 nM, t = 8 h, t½ = 8 h → C(t) = 50 nM.
  await page.getByTestId('input-c0-value').fill('100')
  await page.getByTestId('input-c0-unit').selectOption('nM')
  await page.getByTestId('input-time-value').fill('8')
  await page.getByTestId('input-time-unit').selectOption('h')
  await page.getByTestId('input-halfLife-value').fill('8')
  await page.getByTestId('input-halfLife-unit').selectOption('h')
  await page.getByTestId('calculate-btn').click()

  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('C(t)')
  await expect(page.getByTestId('result-outputs')).toContainText('50')

  // Switch to the rate-constant parameterization (union-discriminant regression).
  await page.getByTestId('pk-mode-k').click()
  await expect(page.getByTestId('pk-mode-k')).toHaveAttribute('aria-checked', 'true')
  await expect(page.getByTestId('pk-mode-halfLife')).toHaveAttribute(
    'aria-checked',
    'false',
  )
  await expect(page.getByTestId('field-k')).toBeVisible()
  await expect(page.getByTestId('field-halfLife')).toBeHidden()
  // A mode change invalidates the previous result.
  await expect(page.getByTestId('result-stale')).toBeVisible()

  await page.getByTestId('input-k-value').fill('0.08664339757') // ≈ ln(2) / 8 h
  await page.getByTestId('input-k-unit').selectOption('1/h')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('calculation-errors')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('C(t)')

  // Switch back: the t½ parameterization still works and typed input survived.
  await page.getByTestId('pk-mode-halfLife').click()
  await expect(page.getByTestId('field-halfLife')).toBeVisible()
  await expect(page.getByTestId('field-k')).toBeHidden()
  await expect(page.getByTestId('input-halfLife-value')).toHaveValue('8')
  await expect(page.getByTestId('input-c0-value')).toHaveValue('100')
  await expect(page.getByTestId('input-time-value')).toHaveValue('8')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('50')
})

test('library: drug record reaches the calculator only via explicit load', async ({
  page,
}) => {
  await createSyntheticDrug(page, 'E2E Synthetic Example', 'E2E-R1', '4')

  await page.getByTestId('calculate-from-detail').click()
  await expect(page.getByRole('heading', { name: 'Calculator' })).toBeVisible()
  await expect(page.getByText('Using parameters from:')).toBeVisible()

  // The candidate is visible but nothing is selected automatically.
  await expect(page.getByTestId('input-kd-load')).toBeVisible()
  await expect(page.getByTestId('input-kd-value')).toHaveValue('')
  await expect(page.getByTestId('source-kd')).toBeHidden()

  // Explicit selection loads value + provenance indicator.
  await page.getByTestId('input-kd-load').selectOption({ index: 1 })
  await expect(page.getByTestId('input-kd-value')).toHaveValue('4')
  await expect(page.getByTestId('source-kd')).toContainText('From library')
  await expect(page.getByTestId('source-kd')).toContainText('E2E-R1 · Kd')
  await expect(
    page.getByTestId('source-kd').getByTestId('provenance-badge'),
  ).toBeVisible()

  // Synthetic concentration only — the Kd stays loaded from the library.
  await page.getByTestId('input-concentration-value').fill('10')
  await page.getByTestId('input-concentration-unit').selectOption('nM')
  await page.getByTestId('calculate-btn').click()

  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  // 10 / (10 + 4) = 0.714…
  await expect(page.getByTestId('result-outputs')).toContainText('0.714')
  // The library value keeps its provenance inside the report's inputs.
  await expect(page.getByTestId('result-inputs')).toContainText('4 nM')
  await expect(
    page.getByTestId('result-inputs').getByTestId('provenance-badge'),
  ).toBeVisible()
})

test('stale: input edits and library loads mark the result stale until recalculated', async ({
  page,
}) => {
  await createSyntheticDrug(page, 'E2E Stale Example', 'E2E-R1', '4')
  await page.getByTestId('calculate-from-detail').click()
  await expect(page.getByTestId('calculator-view')).toBeVisible()

  await fillOccupancy(page, '10', '10')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeHidden()

  // 1. Editing a calculation input marks the result stale.
  await page.getByTestId('input-concentration-value').fill('20')
  await expect(page.getByTestId('result-stale')).toBeVisible()
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-stale')).toBeHidden()

  // 2. Loading a different value from the library marks the result stale.
  await page.getByTestId('input-kd-load').selectOption({ index: 1 })
  await expect(page.getByTestId('input-kd-value')).toHaveValue('4')
  await expect(page.getByTestId('result-stale')).toBeVisible()
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('source-kd')).toContainText('From library')
})

test('curve: explicit range generates the chart and settings changes are flagged', async ({
  page,
}) => {
  await page.goto('/calculator')
  await page.getByTestId('model-select').selectOption('occupancy.single-site')
  await fillOccupancy(page, '10', '10')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()

  // A successful calculation without an explicit range never draws a chart.
  await expect(page.getByTestId('range-not-configured')).toBeVisible()
  await expect(page.getByTestId('no-curve')).toBeVisible()
  await expect(page.getByTestId('curve-chart')).toBeHidden()
  await expect(page.getByTestId('x-scale-log')).toBeChecked()

  await page.getByTestId('range-min').fill('0.1')
  await page.getByTestId('range-max').fill('100')
  await page.getByTestId('apply-curve').click()

  await expect(page.getByTestId('curve-chart')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('range-not-configured')).toBeHidden()
  await expect(page.getByTestId('curve-settings-stale')).toBeHidden()

  // Changing the range flags the settings as changed until the curve is updated.
  await page.getByTestId('range-max').fill('200')
  await expect(page.getByTestId('curve-settings-stale')).toBeVisible()
  await page.getByTestId('apply-curve').click()
  await expect(page.getByTestId('curve-settings-stale')).toBeHidden()
  await expect(page.getByTestId('curve-chart')).toBeVisible()
})

test('curve validation: a cleared C0 blocks Update curve with the schema message, then recovers (phase 27)', async ({
  page,
}) => {
  await page.goto('/calculator')
  await expect(page.getByTestId('calculator-view')).toBeVisible()
  await page.getByTestId('model-select').selectOption('pk.first-order-one-compartment')

  // Synthetic inputs: C0 = 100 µM, t = 1 h, t½ = 1 h → C(1) = 50 µM.
  await fillPK(page, '100', '1', '1')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('calculation-errors')).toBeHidden()
  await expect(page.getByTestId('result-stale')).toBeHidden()
  await expect(page.getByTestId('result-outputs')).toContainText('50')

  // Explicit range 0–10 h (valid for the PK default linear x) draws the chart.
  await page.getByTestId('range-min').fill('0')
  await page.getByTestId('range-max').fill('10')
  await page.getByTestId('apply-curve').click()
  await expect(page.getByTestId('curve-chart')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('range-not-configured')).toBeHidden()

  // Assert the chart rendered the expected PK curve with actual SVG path geometry:
  // C(0) = 100 µM and C(10) = 100 · 2^−10 ≈ 0.09765625 µM.
  await expectRenderedCurveEndpoints(page, { x0: 0, xLast: 10, y0: 100, yLast: 0.09765625 })

  // The user clears C0 entirely: the existing report is marked stale.
  await page.getByTestId('input-c0-value').fill('')
  await expect(page.getByTestId('result-stale')).toBeVisible()

  // "Update curve" must refuse the blank input — never a silent zero curve.
  await page.getByTestId('apply-curve').click()
  await expect(page.getByTestId('input-c0-value')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByTestId('error-c0')).toContainText('Enter a value.')
  // The message is reachable through the input's aria-describedby relationship.
  const describedBy = await page.getByTestId('input-c0-value').getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`#${describedBy}`)).toContainText('Enter a value.')
  // The chart is removed — no all-zero replacement is drawn.
  await expect(page.getByTestId('curve-chart')).toBeHidden()
  await expect(page.getByTestId('no-curve')).toBeVisible()
  // No misleading engine zero-rejection for a field the user left blank.
  await expect(page.getByTestId('curve-errors')).toBeHidden()
  await expect(page.getByTestId('calculation-errors')).toBeHidden()
  // The previous report survives only as a stale result (C(1) = 50 µM).
  await expect(page.getByTestId('result-panel')).toBeVisible()
  await expect(page.getByTestId('result-stale')).toBeVisible()
  await expect(page.getByTestId('result-outputs')).toContainText('50')

  // Recovery: editing the field clears the inline error, and Update curve
  // regenerates the chart with the original endpoints.
  await page.getByTestId('input-c0-value').fill('100')
  await expect(page.getByTestId('error-c0')).toBeHidden()
  await page.getByTestId('apply-curve').click()
  await expect(page.getByTestId('curve-chart')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('no-curve')).toBeHidden()
  // Assert the recovered chart has re-rendered the curve with correct endpoints.
  await expectRenderedCurveEndpoints(page, { x0: 0, xLast: 10, y0: 100, yLast: 0.09765625 })
})

test('curve validation: a cleared C0 also blocks the automatic scale-change re-apply (phase 27)', async ({
  page,
}) => {
  await page.goto('/calculator')
  await page.getByTestId('model-select').selectOption('pk.first-order-one-compartment')

  await fillPK(page, '100', '1', '1')
  await page.getByTestId('calculate-btn').click()
  await expect(page.getByTestId('result-panel')).toBeVisible()

  // Range valid for BOTH linear and log x (min > 0) so a range-validation
  // error can never mask the input-validation behaviour under test.
  await page.getByTestId('range-min').fill('1')
  await page.getByTestId('range-max').fill('10')
  await page.getByTestId('apply-curve').click()
  await expect(page.getByTestId('curve-chart')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('x-scale-linear')).toBeChecked()
  // Assert the chart rendered with actual SVG path geometry.
  // C(1) = 50 µM and C(10) ≈ 0.09765625 µM for the 1–10 h range.
  await expectRenderedCurveEndpoints(page, { x0: 1, xLast: 10, y0: 50, yLast: 0.09765625 })

  // Clear C0, then change the x-axis scale: the store auto-applies the
  // curve settings, which must hit the same validation gate. The radio
  // input itself is visually hidden (sr-only), so the visible label text
  // inside the X-axis radiogroup is the real click target.
  await page.getByTestId('input-c0-value').fill('')
  await page
    .getByRole('radiogroup', { name: 'X axis scale' })
    .getByText('log', { exact: true })
    .click()

  // No curve from the blank value; the chart is removed, not zeroed.
  await expect(page.getByTestId('x-scale-log')).toBeChecked()
  await expect(page.getByTestId('curve-chart')).toBeHidden()
  await expect(page.getByTestId('no-curve')).toBeVisible()
  // The same schema-level contract as the explicit Update curve path.
  await expect(page.getByTestId('input-c0-value')).toHaveAttribute('aria-invalid', 'true')
  await expect(page.getByTestId('error-c0')).toContainText('Enter a value.')
  const describedBy = await page.getByTestId('input-c0-value').getAttribute('aria-describedby')
  expect(describedBy).toBeTruthy()
  await expect(page.locator(`#${describedBy}`)).toContainText('Enter a value.')
  // No engine zero-rejection surfaced merely because the value was blank.
  await expect(page.getByTestId('curve-errors')).toBeHidden()
  await expect(page.getByTestId('calculation-errors')).toBeHidden()
  // The prior scalar report remains, marked stale.
  await expect(page.getByTestId('result-stale')).toBeVisible()
  await expect(page.getByTestId('result-outputs')).toContainText('50')
})
