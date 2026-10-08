/**
 * CalculationTrace — renders the structured trace steps from a
 * CalculationResult. Each step shows index, label, expression, substituted
 * values, and the result. No equations are recreated here; the engine
 * supplies the structured data.
 */
import type { TraceStep } from '@/engine/types'

function formatValue(value: TraceStep['result']): string {
  const { value: v, unit } = value
  // Use toLocaleString for readability but preserve scientific notation for very small/large
  const str = Number.isFinite(v) ? v.toString() : String(v)
  return `${str} ${unit}`.trim()
}

export function CalculationTrace({ trace }: { trace: readonly TraceStep[] }) {
  if (trace.length === 0) return null

  return (
    <section className="space-y-3" data-testid="calculation-trace">
      <h3 className="text-sm font-medium">Calculation Trace</h3>
      <ol className="space-y-3">
        {trace.map((step) => (
          <li
            key={step.index}
            className="rounded-md border p-3"
            data-testid={`trace-step-${step.index}`}
          >
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                Step {step.index}
              </span>
              <span className="font-medium">{step.label}</span>
            </div>
            <p className="mt-1 font-mono text-sm">{step.expression}</p>
            <p className="mt-1 text-sm text-muted-foreground font-mono">
              = {step.substituted}
            </p>
            <p className="mt-1 text-sm">
              →{' '}
              <span className="font-mono">{formatValue(step.result)}</span>
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}