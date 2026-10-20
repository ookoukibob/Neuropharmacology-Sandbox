/**
 * Saved simulation scenario — domain record (phase 45).
 *
 * A saved scenario is a NAMED COPY of the editor draft. It stores the draft
 * faithfully — string-backed field values exactly as the editor holds them,
 * including blank or currently invalid input — so loading restores the
 * editable state and the existing validation path reports what is wrong.
 *
 * It deliberately stores NO simulation output: no samples, charts,
 * diagnostics or event traces. A saved scenario is not a result.
 */
import type { SimulationDraft } from '../../features/simulation/draft'

export type ScenarioId = string

export interface SavedScenario {
  readonly id: ScenarioId
  /** Display name, trimmed; non-empty. Not unique — ids identify records. */
  readonly name: string
  /** ISO 8601 creation / last-modification timestamps. */
  readonly createdAt: string
  readonly updatedAt: string
  /** The complete editable draft, verbatim. */
  readonly draft: SimulationDraft
}

/** Summary row for lists — everything except the (possibly large) draft. */
export interface SavedScenarioSummary {
  readonly id: ScenarioId
  readonly name: string
  readonly createdAt: string
  readonly updatedAt: string
}

export const MAX_SCENARIO_NAME_LENGTH = 80

/**
 * Name policy (shared by the UI and the repository):
 * - surrounding whitespace is trimmed;
 * - an empty or whitespace-only name is rejected;
 * - names are NOT required to be unique (ids identify records), and two
 *   records with the same name can never overwrite each other.
 */
export function normalizeScenarioName(raw: string): { readonly ok: true; readonly name: string } | { readonly ok: false; readonly message: string } {
  const name = raw.trim()
  if (name === '') return { ok: false, message: 'A scenario name is required.' }
  if (name.length > MAX_SCENARIO_NAME_LENGTH) {
    return { ok: false, message: `A scenario name may be at most ${MAX_SCENARIO_NAME_LENGTH} characters.` }
  }
  return { ok: true, name }
}

export function toScenarioSummary(scenario: SavedScenario): SavedScenarioSummary {
  return {
    id: scenario.id,
    name: scenario.name,
    createdAt: scenario.createdAt,
    updatedAt: scenario.updatedAt,
  }
}
