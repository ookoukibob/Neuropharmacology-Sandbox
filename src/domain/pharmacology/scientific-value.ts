import type { Provenance } from '../provenance/provenance'

/**
 * A scientific value is a triple of (value, unit, provenance).
 *
 * The application never stores pharmacological parameters as bare numbers:
 *
 *   { value: 4.2, unit: "nM", provenance: { type: "literature", ... } }
 *
 * `Unit` is a string by design: the schema layer validates symbols against
 * the unit catalog, while the domain stays decoupled from the catalog.
 */
export interface ScientificValue<Unit extends string = string> {
  readonly value: number
  readonly unit: Unit
  readonly provenance: Provenance
}

/**
 * Parameters that may legitimately be absent. Absence is meaningful: it means
 * "not provided", which the calculators report as a missing-input error
 * instead of substituting a default.
 */
export type MaybeScientificValue = ScientificValue | undefined
