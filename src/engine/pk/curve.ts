/**
 * PK curve generation — chart-agnostic (no Plotly here).
 *
 * Each x is evaluated through `calculateFirstOrderPK`, so a curve point at t
 * is by construction the same value the scalar calculation reports at t.
 * Underflowing points become 0 and are counted into `curve.warnings` instead
 * of being silently flattened.
 */
import { buildXValues, validateCurveOptions, type CurveOptions } from '../curve/sampling'
import type { CalculationWarning, CurveData, CurveGenerationResult, CurvePoint } from '../types'
import { calculateFirstOrderPK, type FirstOrderPKInput } from './model'

const MODEL_ID = 'pk.first-order-one-compartment' as const

export function generatePKCurve(
  input: FirstOrderPKInput,
  options: CurveOptions,
): CurveGenerationResult {
  const range = validateCurveOptions(options, 'linear')
  if (!range.ok) return { ok: false, model: MODEL_ID, errors: range.errors }

  const points: CurvePoint[] = []
  let underflowed = 0
  for (const x of buildXValues(range.options)) {
    const report = calculateFirstOrderPK({ ...input, time: { ...input.time, value: x } })
    if (!report.ok) return { ok: false, model: report.model, errors: report.errors }
    const output = report.result.outputs[0]
    if (output === undefined) {
      return {
        ok: false,
        model: MODEL_ID,
        errors: [
          { code: 'NUMERICAL_ERROR', message: 'The model produced no concentration output for a sampled point.' },
        ],
      }
    }
    points.push({ x, y: output.value })
    if (report.result.warnings.some((w) => w.code === 'NUMERICAL_UNDERFLOW')) underflowed++
  }

  const warnings: CalculationWarning[] = []
  if (underflowed > 0) {
    warnings.push({
      code: 'NUMERICAL_UNDERFLOW',
      severity: 'info',
      message: `${underflowed} of ${points.length} sampled points underflowed to 0.`,
    })
  }

  const curve: CurveData = {
    model: MODEL_ID,
    xLabel: 'Time',
    yLabel: 'Concentration',
    xUnit: input.time.unit,
    yUnit: input.c0.unit,
    xScale: range.options.xScale,
    yScale: range.options.yScale,
    series: [
      {
        id: 'pk.concentration',
        name: 'C(t)',
        seriesType: 'model',
        points,
        xUnit: input.time.unit,
        yUnit: input.c0.unit,
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
  }
  return { ok: true, curve }
}
