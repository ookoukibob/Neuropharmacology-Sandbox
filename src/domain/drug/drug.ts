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
 * External source identity of a target — a portable reference record
 * attached when a target association was established through a data
 * source.
 *
 * Honest semantics: this records *what the source calls the target* —
 * its own authoritative identifier, the reported name/organism, the
 * target-record URL and the source's licensing/attribution terms. It is
 * NOT proof of biological identity: two targets sharing a source id are
 * the same record *in that source system*, and acknowledging a mismatch
 * never claims the targets are biologically identical.
 *
 * Internal vs external identity: `ReceptorTarget.id` is this
 * application's opaque row identity; a source reference never replaces
 * it, and different source systems may each carry their own reference on
 * the same local target (none silently replaces another).
 */
export interface TargetSourceReference {
  /** Adapter id that supplied the target identity (e.g. 'chembl'). */
  readonly source: string
  /** Display name of that source (e.g. 'ChEMBL'). */
  readonly sourceName: string
  /** Authoritative target identifier within that source system. */
  readonly sourceTargetId: string
  /** Target name as reported by that source, when supplied. */
  readonly name?: string
  /** Organism as reported by that source, when supplied. */
  readonly organism?: string
  /** URL identifying this target record at the source (absolute HTTPS). */
  readonly url?: string
  /** Source licensing/attribution notice, verbatim. */
  readonly licenseNotice?: string
  /** Link to the source's licensing/terms page (absolute HTTPS). */
  readonly licenseUrl?: string
}

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
  /**
   * External source identities reported for this target (see
   * `TargetSourceReference`). Optional: records without any stay without
   * the key. At most one reference per source — see
   * `mergeSourceReferences` for the enforced merge rule.
   */
  readonly sourceReferences?: readonly TargetSourceReference[]
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

/** The reference this target carries from `source`, if any. */
export function findSourceReference(
  references: readonly TargetSourceReference[] | undefined,
  source: string,
): TargetSourceReference | undefined {
  return references?.find((reference) => reference.source === source)
}

/**
 * Attach `reference` to a target's reference list under the identity
 * rules of phase 18I:
 * - an identical reference (same source + same sourceTargetId) is a
 *   no-op — repeated applications never create duplicates;
 * - a reference from a different source system is appended — no source's
 *   identity ever silently replaces another's;
 * - a CONFLICT (same source, different sourceTargetId) is never merged
 *   or overwritten here: the list is returned unchanged and the stored
 *   conflicting reference is reported so the caller handles it
 *   explicitly (acknowledgement, refusal), never silently.
 */
export function mergeSourceReferences(
  existing: readonly TargetSourceReference[] | undefined,
  reference: TargetSourceReference,
): {
  readonly references: readonly TargetSourceReference[]
  readonly conflict?: TargetSourceReference
} {
  const current = existing ?? []
  const same = findSourceReference(current, reference.source)
  if (same === undefined) return { references: [...current, reference] }
  if (same.sourceTargetId === reference.sourceTargetId) return { references: current }
  return { references: current, conflict: same }
}
