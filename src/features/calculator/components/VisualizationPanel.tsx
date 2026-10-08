/**
 * VisualizationPanel — curve range controls, scale toggles, and the
 * lazy-loaded Plotly chart.
 *
 * The engine requires an explicit curve range (min, max, points). The UI
 * exposes these as editable fields with an "Update curve" button — the
 * range is never hidden or invented. Scale toggles (linear/log) apply
 * immediately and regenerate the curve if a valid report exists.
 *
 * Log-y safety: if the engine returns a LOG_Y_AXIS_NOT_REPRESENTABLE
 * warning, the chart adapter forces linear y-axis and this panel surfaces
 * the structured warning verbatim with an explanation.
 */
import { AlertCircle, Info } from 'lucide-react'
import { Suspense, lazy } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type { CurveData } from '@/engine/types'
import type { CurveSettings } from '../store'

const LazyCurveChart = lazy(() =>
  import('@/components/charts/CurveChart').then((mod) => ({
    default: mod.CurveChart,
  })),
)

interface VisualizationPanelProps {
  readonly curve: CurveData | null
  readonly curveErrors: readonly import('@/engine/types').CalculationError[]
  readonly settings: CurveSettings
  readonly hasValidReport: boolean
  readonly curveSettingsStale: boolean
  readonly onRangeChange: (patch: Partial<CurveSettings['range']>) => void
  readonly onXScaleChange: (scale: 'linear' | 'log') => void
  readonly onYScaleChange: (scale: 'linear' | 'log') => void
  readonly onApply: () => void
  readonly xUnitHint: string
}

export function VisualizationPanel({
  curve,
  curveErrors,
  settings,
  hasValidReport,
  curveSettingsStale,
  onRangeChange,
  onXScaleChange,
  onYScaleChange,
  onApply,
  xUnitHint,
}: VisualizationPanelProps) {
  // Detect LOG_Y warning in curve
  const logYWarning = curve?.warnings?.find((w) => w.code === 'LOG_Y_AXIS_NOT_REPRESENTABLE')

  // Determine if range is configured (both min and max provided)
  const rangeConfigured = settings.range.min.trim() !== '' && settings.range.max.trim() !== ''

  return (
    <section className="space-y-4" data-testid="visualization-panel">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Visualization</h3>
        <p className="text-xs text-muted-foreground">
          The curve is sampled by the calculation engine over an explicit range
          — this chart never computes pharmacology.
        </p>
      </div>

      {/* Curve settings stale notice */}
      {curveSettingsStale && hasValidReport && (
        <Alert data-testid="curve-settings-stale">
          <Info className="size-4" aria-hidden="true" />
          <AlertTitle>Curve settings changed</AlertTitle>
          <AlertDescription className="text-sm">
            Curve settings have been modified since the last visualization update.
            Click "Update curve" to refresh the chart with current settings.
          </AlertDescription>
        </Alert>
      )}

      {/* Range controls */}
      <div className="flex flex-wrap items-end gap-4 rounded-md border p-3">
        <div className="grid gap-1.5 min-w-32">
          <Label htmlFor="range-min" className="text-xs text-muted-foreground">
            Range min
          </Label>
          <Input
            id="range-min"
            type="text"
            value={settings.range.min}
            onChange={(e) => onRangeChange({ min: e.target.value })}
            placeholder={xUnitHint ? `in ${xUnitHint}` : 'e.g. 0'}
            data-testid="range-min"
          />
        </div>
        <div className="grid gap-1.5 min-w-32">
          <Label htmlFor="range-max" className="text-xs text-muted-foreground">
            Range max
          </Label>
          <Input
            id="range-max"
            type="text"
            value={settings.range.max}
            onChange={(e) => onRangeChange({ max: e.target.value })}
            placeholder={xUnitHint ? `in ${xUnitHint}` : 'e.g. 1000'}
            data-testid="range-max"
          />
        </div>
        <div className="grid gap-1.5 min-w-24">
          <Label htmlFor="range-points" className="text-xs text-muted-foreground">
            Points (blank = 200)
          </Label>
          <Input
            id="range-points"
            type="text"
            value={settings.range.points}
            onChange={(e) => onRangeChange({ points: e.target.value })}
            inputMode="numeric"
            data-testid="range-points"
          />
        </div>

        {/* X scale */}
        <fieldset className="flex items-end gap-2">
          <legend className="text-xs text-muted-foreground">X axis</legend>
          <div className="flex gap-2" role="radiogroup" aria-label="X axis scale">
            {(['linear', 'log'] as const).map((scale) => (
              <label key={scale} className="inline-flex items-center gap-1">
                <input
                  type="radio"
                  name="x-scale"
                  value={scale}
                  checked={settings.xScale === scale}
                  onChange={() => onXScaleChange(scale)}
                  className="sr-only"
                  aria-label={scale}
                  data-testid={`x-scale-${scale}`}
                />
                <span
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    settings.xScale === scale
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-input hover:bg-muted'
                  }`}
                >
                  {scale}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        {/* Y scale */}
        <fieldset className="flex items-end gap-2">
          <legend className="text-xs text-muted-foreground">Y axis</legend>
          <div className="flex gap-2" role="radiogroup" aria-label="Y axis scale">
            {(['linear', 'log'] as const).map((scale) => (
              <label key={scale} className="inline-flex items-center gap-1">
                <input
                  type="radio"
                  name="y-scale"
                  value={scale}
                  checked={settings.yScale === scale}
                  onChange={() => onYScaleChange(scale)}
                  className="sr-only"
                  aria-label={scale}
                  data-testid={`y-scale-${scale}`}
                />
                <span
                  className={`px-2 py-1 text-xs rounded border transition-colors ${
                    settings.yScale === scale
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-input hover:bg-muted'
                  }`}
                >
                  {scale}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <Button
          onClick={onApply}
          disabled={!hasValidReport}
          data-testid="apply-curve"
        >
          Update curve
        </Button>
      </div>

      {/* Range not configured notice */}
      {hasValidReport && !rangeConfigured && curveErrors.length === 0 && (
        <Alert data-testid="range-not-configured">
          <Info className="size-4" aria-hidden="true" />
          <AlertTitle>Curve range not configured</AlertTitle>
          <AlertDescription className="text-sm">
            Enter a minimum and maximum value for the range, then click "Update curve"
            to generate the visualization. The engine requires an explicit plotting domain.
          </AlertDescription>
        </Alert>
      )}

      {/* Curve errors (validation failures after explicit range was provided) */}
      {curveErrors.length > 0 && (
        <Alert variant="destructive" data-testid="curve-errors">
          <AlertCircle className="size-4" aria-hidden="true" />
          <AlertTitle>Curve not generated</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4 space-y-1">
              {curveErrors.map((e, i) => (
                <li key={i} className="text-sm">{e.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* LOG_Y warning notice */}
      {logYWarning && (
        <Alert data-testid="log-y-notice">
          <Info className="size-4" aria-hidden="true" />
          <AlertTitle>Logarithmic Y axis not representable</AlertTitle>
          <AlertDescription>
            <p className="text-sm">{logYWarning.message}</p>
            <p className="text-xs text-muted-foreground mt-1">
              The chart below uses a linear y-axis; the curve data is unchanged.
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* Curve warnings (underflow, etc.) */}
      {curve?.warnings &&
        curve.warnings.length > 0 &&
        curve.warnings.some((w) => w.code !== 'LOG_Y_AXIS_NOT_REPRESENTABLE') && (
          <Alert data-testid="curve-warnings">
            <AlertCircle className="size-4" aria-hidden="true" />
            <AlertTitle>Curve warnings</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4 space-y-1">
                {curve.warnings
                  .filter((w) => w.code !== 'LOG_Y_AXIS_NOT_REPRESENTABLE')
                  .map((w, i) => (
                    <li key={i} className="text-sm">
                      <span className="font-mono text-xs mr-1">{w.code}</span>{' '}
                      {w.message}
                    </li>
                  ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

      {/* Chart or empty state */}
      {curve ? (
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading chart…</p>}>
          <LazyCurveChart curve={curve} />
        </Suspense>
      ) : !hasValidReport ? (
        <p className="text-sm text-muted-foreground" data-testid="no-curve">
          Calculate to generate a curve.
        </p>
      ) : !rangeConfigured ? (
        <p className="text-sm text-muted-foreground" data-testid="no-curve">
          Enter a range and click "Update curve" to generate.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="no-curve">
          Click "Update curve" to generate.
        </p>
      )}
    </section>
  )
}