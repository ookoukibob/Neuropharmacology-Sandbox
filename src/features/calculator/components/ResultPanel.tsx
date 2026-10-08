/**
 * ResultPanel — renders a successful CalculationResult with:
 * - Outputs (symbol, label, value, unit)
 * - Formula
 * - Inputs used (with provenance chips)
 * - Assumptions
 * - Warnings (distinguishing severity, showing codes verbatim)
 *
 * A stale banner is shown if inputs have changed since the calculation.
 */
import { Info, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { ProvenanceBadge } from './ProvenanceBadge'
import type { CalculationResult } from '@/engine/types'

function WarningIcon({ severity }: { severity: 'info' | 'warning' }) {
  return severity === 'warning' ? (
    <AlertTriangle aria-hidden="true" className="size-4 text-warning" />
  ) : (
    <Info aria-hidden="true" className="size-4 text-blue-500" />
  )
}

function formatOutputValue(value: CalculationResult['outputs'][0]): string {
  return `${value.value} ${value.unit}`.trim()
}

export function ResultPanel({
  result,
  stale,
}: {
  readonly result: CalculationResult
  readonly stale: boolean
}) {
  const [showAssumptions, setShowAssumptions] = useState(true)
  const [showWarnings, setShowWarnings] = useState(true)

  return (
    <div className="space-y-4" data-testid="result-panel">
      {stale && (
        <div
          className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800"
          data-testid="result-stale"
        >
          Inputs changed since this result was calculated — recalculate for current inputs.
        </div>
      )}

      {/* Outputs */}
      <section className="space-y-2" data-testid="result-outputs">
        <h4 className="text-sm font-medium">Result</h4>
        <div className="grid gap-2 sm:grid-cols-2">
          {result.outputs.map((output, idx) => (
            <div
              key={output.symbol ?? output.label ?? idx}
              className="rounded-md border p-3"
              data-testid="result-output"
            >
              <div className="flex items-baseline gap-2">
                {output.symbol && (
                  <span className="font-mono text-lg">{output.symbol}</span>
                )}
                <span className="text-muted-foreground">{output.label}</span>
              </div>
              <p className="mt-1 font-mono text-lg">{formatOutputValue(output)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Formula */}
      <section className="space-y-1" data-testid="result-formula">
        <h4 className="text-sm font-medium">Formula</h4>
        <p className="font-mono text-sm bg-muted p-2 rounded">{result.formula}</p>
      </section>

      {/* Inputs used */}
      <section className="space-y-2" data-testid="result-inputs">
        <h4 className="text-sm font-medium">Inputs Used</h4>
        <div className="space-y-1">
          {result.inputs.map((input, idx) => (
            <div
              key={input.symbol ?? idx}
              className="flex flex-wrap items-center gap-2 text-sm"
              data-testid="result-input"
            >
              <span className="font-mono w-16">{input.symbol}</span>
              <span className="text-muted-foreground w-24">{input.label}</span>
              <span className="font-mono">{input.value} {input.unit}</span>
              {input.provenance ? (
                <ProvenanceBadge provenance={input.provenance} />
              ) : (
                <Badge variant="secondary" className="text-xs">
                  User-entered
                </Badge>
              )}
            </div>
          ))}
        </div>
      </section>

      {/* Assumptions */}
      <section className="space-y-2" data-testid="result-assumptions">
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setShowAssumptions(!showAssumptions)}
          aria-expanded={showAssumptions}
        >
          {showAssumptions ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Assumptions ({result.assumptions.length})
        </button>
        {showAssumptions && (
          <ul className="ml-4 list-disc space-y-1 text-sm">
            {result.assumptions.map((a, i) => (
              <li key={i} data-testid="assumption">
                {a}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Warnings */}
      <section className="space-y-2" data-testid="result-warnings">
        <button
          type="button"
          className="flex items-center gap-1 text-sm font-medium text-muted-foreground hover:text-foreground"
          onClick={() => setShowWarnings(!showWarnings)}
          aria-expanded={showWarnings}
        >
          {showWarnings ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          Warnings ({result.warnings.length})
        </button>
        {showWarnings && (
          <ul className="space-y-2">
            {result.warnings.map((w, i) => (
              <li key={i} className="rounded-md border p-3 text-sm" data-testid="warning-item">
                <div className="flex items-start gap-2">
                  <WarningIcon severity={w.severity} />
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="text-xs font-mono">
                        {w.code}
                      </Badge>
                      <span className="font-medium capitalize">{w.severity}</span>
                    </div>
                    <p className="mt-1">{w.message}</p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}