import type { MaybeScientificValue } from '../pharmacology/scientific-value'

/** Opaque identifier (UUID v4 for user data, stable slugs for built-in data). */
export type DrugId = string

/** Opaque identifier for a target entry within a drug record. */
export type TargetId = string

/**
 * Where the record came from. `built-in-demo` records must be visibly marked
 * as example/demo data in the UI and must never be presented as authoritative.
 */
export type DrugOrigin = 'built-in-demo' | 'user' | 'imported'

export interface DrugIdentifiers {
  readonly name: string
  readonly synonyms: readonly string[]
  readonly description?: string
  readonly casNumber?: string
}

/**
 * Pharmacological action at a target. Terminology is intentionally
 * conservative: it describes *reported mode of action*, not effect size.
 */
export type TargetAction =
  | 'agonist'
  | 'partial-agonist'
  | 'antagonist'
  | 'inverse-agonist'
  | 'modulator'
  | 'reuptake-inhibitor'
  | 'unknown'

/**
 * One drug -> one target relationship with its binding/pharmacodynamic
 * parameters.
 *
 * Kd, Ki, EC50 and IC50 are separate, explicitly named fields. The engine
 * must never substitute one for another (Kd != Ki).
 */
export interface ReceptorTarget {
  readonly id: TargetId
  /** Target symbol as used in the literature, e.g. "SERT", "5-HT2A". */
  readonly name: string
  /** HGNC gene symbol when known, e.g. "SLC6A4". */
  readonly gene?: string
  readonly action?: TargetAction
  /** Species the measurement applies to, e.g. "human". */
  readonly species?: string
  /** Equilibrium dissociation constant. Unit: molar concentration. */
  readonly kd?: MaybeScientificValue
  /** Inhibition constant — NOT a Kd. Unit: molar concentration. */
  readonly ki?: MaybeScientificValue
  /** Potency for a functional response. Unit: molar concentration. */
  readonly ec50?: MaybeScientificValue
  /** Concentration for half-maximal inhibition. Unit: molar concentration. */
  readonly ic50?: MaybeScientificValue
  readonly notes?: string
}

/**
 * Pharmacokinetic parameters of a drug record. All optional: a parameter that
 * is absent is reported as missing by the calculators, never guessed.
 */
export interface Pharmacokinetics {
  /** Terminal/half-life. Unit: time. */
  readonly halfLife?: MaybeScientificValue
  /** Clearance. Unit: volume/time (as a derived unit string, e.g. "mL/min"). */
  readonly clearance?: MaybeScientificValue
  /** Volume of distribution. Unit: volume (e.g. "L"). */
  readonly volumeOfDistribution?: MaybeScientificValue
  /** Bioavailability. Unit: dimensionless fraction (unit "1" or "%"). */
  readonly bioavailability?: MaybeScientificValue
  readonly notes?: string
}

export interface Drug {
  readonly id: DrugId
  readonly identifiers: DrugIdentifiers
  readonly origin: DrugOrigin
  readonly tags: readonly string[]
  /** Binding/pharmacodynamic parameters per target. */
  readonly targets: readonly ReceptorTarget[]
  readonly pharmacokinetics: Pharmacokinetics
  readonly notes?: string
  /** ISO 8601. Absent for legacy imports; the importer fills it. */
  readonly createdAt?: string
  readonly updatedAt?: string
}
