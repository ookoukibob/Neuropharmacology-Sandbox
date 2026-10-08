/**
 * Occupancy curve — occupancy (fraction) vs free concentration, chart-agnostic.
 * Each x runs through `calculateReceptorOccupancy`, so curve points equal the
 * scalar calculation. Log-x is the default for concentration axes.
 */
import { buildXValues, validateCurveOptions, type CurveOptions } from '../curve/sampling'
import type { CalculationWarning, CurveData, CurveGenerationResult, CurvePoint } from '../types'
import { calculateReceptorOccupancy, type ReceptorOccupancyInput } from './model'

const MODEL_ID = 'occupancy.single-site' as const

export function generateOccupancyCurve(
  input: ReceptorOccupancyInput,
  options: CurveOptions,
): CurveGenerationResult {
  const range = validateCurveOptions(options, 'log')
  if (!range.ok) return { ok: false, model: MODEL_ID, errors: range.errors }

  const points: CurvePoint[] = []
  let underflowed = 0
  for (const x of buildXValues(range.options)) {
    const report = calculateReceptorOccupancy({
      ...input,
      concentration: { ...input.concentration, value: x },
    })
    if (!report.ok) return { ok: false, model: report.model, errors: report.errors }
    const output = report.result.outputs[0]
    if (output === undefined) {
      return {
        ok: false,
        model: MODEL_ID,
        errors: [
          { code: 'NUMERICAL_ERROR', message: 'The model produced no occupancy output for a sampled point.' },
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
    xLabel: 'Concentration',
    yLabel: 'Occupancy (fraction)',
    xUnit: input.concentration.unit,
    yUnit: '1',
    xScale: range.options.xScale,
    yScale: range.options.yScale,
    series: [
      {
        id: 'occupancy.fraction',
        name: 'Occupancy',
        seriesType: 'model',
        points,
        xUnit: input.concentration.unit,
        yUnit: '1',
      },
    ],
    ...(warnings.length > 0 ? { warnings } : {}),
  }
  return { ok: true, curve }
}
