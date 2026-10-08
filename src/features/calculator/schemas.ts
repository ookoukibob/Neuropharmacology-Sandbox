/**
 * Calculator input schemas (phase 4) — one explicit schema/type per model.
 *
 * The schemas mirror the engine input types field-for-field: every field of
 * `FirstOrderPKInput`, `ReceptorOccupancyInput` and `HillResponseInput`
 * appears here as a *string draft* (what a form edits) plus, where a unit is
 * supplied by the user, its unit draft. Validation layers (see
 * docs/calculator.md, "Validation timing"):
 *
 *  1. Zod (this file) — structural checks only: a value must be present and
 *     parse to a finite decimal number; a unit must be present where the
 *     model needs a user-chosen unit. Zod never applies a scientific rule.
 *  2. The engine — the single authority for scientific validation
 *     (positivity, zero semantics, dimension compatibility, ...). The engine
 *     receives the draft only after Zod passes and its errors are rendered
 *     verbatim.
 *
 * No schema field has a default: no default Kd/Ki/EC50/IC50/Hill
 * coefficient/half-life/concentration. The only pre-filled unit in the whole
 * calculator is the Hill coefficient's dimensionless "1", which is the sole
 * value the engine accepts for a dimensionless parameter — not a scientific
 * default.
 *
 * Provenance-carrying `source` is intentionally outside schema validation —
 * it is constructed by the library-selection action, never by typing.
 */
import { z } from 'zod'
import type { Provenance } from '../../domain/provenance/provenance'

/** A library record that can be loaded into a calculator field. */
export interface LibrarySource {
  readonly provenance: Provenance
  /** Human-readable origin, e.g. "TEST-R · Kd" — display only. */
  readonly originLabel: string
}

/** One calculator field draft: raw text as typed, never mutated silently. */
export interface ParameterDraft {
  /** Raw text exactly as typed (validated on submit, never mutated silently). */
  readonly value: string
  readonly unit: string
  /** Set only by an explicit load from a library record; cleared on manual edit. */
  readonly source?: LibrarySource
}

/** A value that may or may not have provenance (for typing convenience). */
export type MaybeParameterDraft = ParameterDraft | undefined

// --- Helpers ---

const NUMBER_PATTERN = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

const numberText = z
  .string()
  .refine((v) => v.trim() !== '', 'Enter a value.')
  .refine((v) => NUMBER_PATTERN.test(v.trim()), 'Enter a decimal number (for example 4.7 or 1e-9).')
  .refine((v) => Number.isFinite(Number(v.trim())), 'Enter a finite number.')

const unitText = z
  .string()
  .refine((v) => v.trim() !== '', 'Select or enter a unit.')

/** A parameter draft with a required unit (concentration, time, rate, effect). */
export const parameterDraftSchema = z.object({
  value: numberText,
  unit: unitText,
})

/** A parameter draft where the unit is fixed by the model (Hill coefficient n). */
export const dimensionlessDraftSchema = z.object({
  value: numberText,
  // unit is not validated here — the engine requires "1" and the builder forces it.
  unit: z.string(),
})

// --- Per-model calculator input schemas ---

const MODEL_IDS = {
  PK: 'pk.first-order-one-compartment' as const,
  OCCUPANCY: 'occupancy.single-site' as const,
  HILL: 'dose-response.hill' as const,
}

/** First-order PK calculator input (discriminated union on mode). */
export const firstOrderPKCalculatorInputSchema = z.discriminatedUnion('mode', [
  z.object({
    model: z.literal(MODEL_IDS.PK),
    mode: z.literal('halfLife'),
    c0: parameterDraftSchema,
    time: parameterDraftSchema,
    halfLife: parameterDraftSchema,
  }),
  z.object({
    model: z.literal(MODEL_IDS.PK),
    mode: z.literal('k'),
    c0: parameterDraftSchema,
    time: parameterDraftSchema,
    k: parameterDraftSchema,
  }),
])

/** Receptor occupancy calculator input. */
export const receptorOccupancyCalculatorInputSchema = z.object({
  model: z.literal(MODEL_IDS.OCCUPANCY),
  concentration: parameterDraftSchema,
  kd: parameterDraftSchema,
})

/** Hill response calculator input. */
export const hillResponseCalculatorInputSchema = z.object({
  model: z.literal(MODEL_IDS.HILL),
  e0: parameterDraftSchema,
  emax: parameterDraftSchema,
  ec50: parameterDraftSchema,
  hillCoefficient: dimensionlessDraftSchema,
  concentration: parameterDraftSchema,
})

// --- Inferred types (exactly match engine input shapes, but with string drafts) ---

export type FirstOrderPKCalculatorInput = z.infer<typeof firstOrderPKCalculatorInputSchema>
export type ReceptorOccupancyCalculatorInput = z.infer<typeof receptorOccupancyCalculatorInputSchema>
export type HillResponseCalculatorInput = z.infer<typeof hillResponseCalculatorInputSchema>

export type CalculatorDraft =
  | FirstOrderPKCalculatorInput
  | ReceptorOccupancyCalculatorInput
  | HillResponseCalculatorInput

// --- Validation helper ---

export interface DraftValidation {
  /** First message per field key ("" for structural issues). */
  readonly fields: Readonly<Record<string, string>>
  readonly issues: readonly string[]
}

function schemaFor(draft: CalculatorDraft) {
  switch (draft.model) {
    case MODEL_IDS.PK:
      return firstOrderPKCalculatorInputSchema
    case MODEL_IDS.OCCUPANCY:
      return receptorOccupancyCalculatorInputSchema
    case MODEL_IDS.HILL:
      return hillResponseCalculatorInputSchema
  }
}

export function validateDraft(draft: CalculatorDraft): DraftValidation {
  const schema = schemaFor(draft)
  const result = schema.safeParse(draft)
  if (result.success) return { fields: {}, issues: [] }
  const fields: Record<string, string> = {}
  const issues: string[] = []
  for (const issue of result.error.issues) {
    const key = issue.path.length > 0 ? String(issue.path[0]) : ''
    if (key === '') {
      issues.push(issue.message)
      continue
    }
    if (fields[key] === undefined) fields[key] = issue.message
  }
  return { fields, issues }
}