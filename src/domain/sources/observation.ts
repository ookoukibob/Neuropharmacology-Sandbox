/**
 * Layer B — experimental observations.
 *
 * One record is one *reported measurement* as supplied by a source: which
 * compound at which target, which endpoint (Ki, Kd, IC50, EC50, ...), what
 * value, in which unit, with which reported qualifier, in which assay
 * context, traceable to its source record. Different measurements may
 * legitimately disagree — they are preserved as separate observations and
 * are never averaged, merged or collapsed into a single "correct" value.
 *
 * Importing observations never turns them into simulation parameters
 * (Layer C): that link only happens through an explicit user selection
 * (see parameterKind, which records — without ever substituting — whether
 * this endpoint maps onto one of the four named model parameter slots).
 *
 * Missing context stays missing: species, assay, unit, qualifier and
 * reference fields are absent when the source does not supply them.
 *
 * Pure domain module: no React, no I/O, no schema imports.
 */
import type { SourceAttribution } from './attribution'

/** Reported qualifier exactly as the source reports it. */
export type ReportedQualifier = '<' | '>' | '<=' | '>=' | '=' | '~'

/**
 * The four explicitly named model parameter slots of a drug record.
 * The engine must never substitute one for another (Kd ≠ Ki).
 */
export type ParameterKind = 'kd' | 'ki' | 'ec50' | 'ic50'

/** Target reference as supplied by the source — all fields optional. */
export interface ObservationTargetRef {
  /** Target name/symbol as reported (e.g. 'Dopamine D2 receptor'). */
  readonly name?: string
  /** Source's target identifier (e.g. ChEMBL target id). */
  readonly sourceTargetId?: string
  /** Organism the measurement applies to, as reported. */
  readonly organism?: string
}

/** Assay context as supplied by the source — all fields optional. */
export interface ObservationAssay {
  readonly assayId?: string
  /** Source's assay type code (e.g. ChEMBL 'B' for binding). */
  readonly assayType?: string
  readonly description?: string
}

/** Publication/reference identifiers as supplied by the source. */
export interface ObservationReference {
  readonly referenceId?: string
  readonly journal?: string
  readonly year?: number
}

export interface ExperimentalObservation {
  /** Stable identity `${source}:${recordId}` (see observationId). */
  readonly id: string
  /** Layer A compound this measurement belongs to. */
  readonly compoundId: string
  /** Authoritative source identifier of that compound. */
  readonly compoundSourceId: string
  /** Compound name when the source supplies it alongside the measurement. */
  readonly compoundName?: string
  readonly target: ObservationTargetRef
  /** Endpoint exactly as reported ('Ki', 'IC50', "Log K'", ...). */
  readonly endpoint: string
  /**
   * Model parameter slot this endpoint maps onto — set only when the
   * endpoint is canonically one of the four named kinds (case-insensitive
   * exact match after trimming). Absent means "no honest mapping exists";
   * the value is never substituted into a different slot.
   */
  readonly parameterKind?: ParameterKind
  /** Reported numeric result. */
  readonly value: number
  /** Reported unit (e.g. 'nM') — absent when the source reports none. */
  readonly unit?: string
  /** Reported qualifier ('<', '>', ...) — absent when not reported. */
  readonly qualifier?: ReportedQualifier
  /**
   * The raw relation string when the source supplied one outside the
   * recognized qualifier set — preserved verbatim rather than dropped or
   * coerced.
   */
  readonly rawRelation?: string
  /** Species (usually the target organism) as reported. */
  readonly species?: string
  readonly assay?: ObservationAssay
  readonly reference?: ObservationReference
  /** Source's free-text comment on the activity record, when supplied. */
  readonly activityComment?: string
  /** Source's data-quality marker, when supplied (kept, never silenced). */
  readonly dataValidityNote?: string
  readonly provenance: SourceAttribution
  /** ISO 8601 bookkeeping stamps assigned at import time. */
  readonly createdAt: string
  readonly updatedAt: string
}

/** An observation as returned by a source adapter, ready to persist. */
export type RemoteObservation = ExperimentalObservation

/**
 * Stable record identity, derived only from the source's own record id —
 * re-fetching the same source record always yields the same key, so
 * duplicate detection never depends on names or on measurement content.
 */
export function observationId(source: string, recordId: string): string {
  return `${source}:${recordId}`
}

/**
 * Map an endpoint onto a model parameter slot — exact canonical names
 * only (case-insensitive, trimmed). Anything else, including quantities
 * that merely look similar (pIC50, Log K', Ki app), stays unmapped:
 * a missing mapping is honest, a substitution is not.
 */
export function parameterKindFor(endpoint: string): ParameterKind | undefined {
  switch (endpoint.trim().toLowerCase()) {
    case 'kd':
      return 'kd'
    case 'ki':
      return 'ki'
    case 'ec50':
      return 'ec50'
    case 'ic50':
      return 'ic50'
    default:
      return undefined
  }
}
