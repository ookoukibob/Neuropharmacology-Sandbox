import type { CalculationValue, TraceStep } from '../types'

/**
 * Ordered trace builder.
 *
 * The trace is structured data (label / expression / substituted / result),
 * not pre-rendered prose — the UI decides layout, the engine supplies facts.
 * Step indices are 1-based so they map 1:1 to rendered rows.
 */
export class TraceBuilder {
  private readonly steps: TraceStep[] = []

  add(label: string, expression: string, substituted: string, result: CalculationValue): this {
    this.steps.push({ index: this.steps.length + 1, label, expression, substituted, result })
    return this
  }

  build(): readonly TraceStep[] {
    return this.steps
  }
}
