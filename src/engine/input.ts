import type { CalculationInput, EngineParameter } from './types'

/**
 * Echo a caller-supplied parameter as a report input. Provenance is copied
 * verbatim when present and the key is omitted entirely when absent — the
 * engine never manufactures or upgrades provenance.
 */
export function toCalculationInput(
  symbol: string,
  label: string,
  parameter: EngineParameter,
): CalculationInput {
  return {
    symbol,
    label,
    value: parameter.value,
    unit: parameter.unit,
    ...(parameter.provenance !== undefined ? { provenance: parameter.provenance } : {}),
  }
}
