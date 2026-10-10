/**
 * Layer A — compound entity.
 *
 * A compound record describes the *identity* of a chemical compound as
 * supplied by an external source: identifiers, names, synonyms and basic
 * structural/property references. It is deliberately independent of both
 * experimental observations (Layer B) and drug-library parameter records
 * (Layer C): downloading identity data never creates simulation inputs.
 *
 * Identity is keyed on the authoritative source identifier
 * (`${source}:${sourceId}`) — never on the compound name, which is absent
 * or ambiguous for many records. Fields a source does not supply stay
 * absent rather than being guessed.
 *
 * Pure domain module: no React, no I/O, no schema imports.
 */
import type { SourceAttribution } from './attribution'

/** Identifiers and basic property references — every field is optional. */
export interface CompoundIdentifiers {
  /** PubChem compound id (string form — it is an opaque identifier here). */
  readonly pubchemCid?: string
  /** ChEMBL molecule identifier (e.g. 'CHEMBL25'). */
  readonly chemblId?: string
  /** InChIKey — the structural identity key when the source supplies it. */
  readonly inchiKey?: string
  /** Structure reference (canonical SMILES) as reported by the source. */
  readonly smiles?: string
  readonly molecularFormula?: string
  /** Average molecular weight as reported by the source, in g/mol. */
  readonly molecularWeight?: number
  /** CAS registry number — only when the source explicitly supplies it. */
  readonly casNumber?: string
}

export interface Compound {
  /** Stable identity `${source}:${sourceId}` (see compoundId). */
  readonly id: string
  /** Adapter id that supplied the record ('pubchem', 'chembl', ...). */
  readonly source: string
  /** Authoritative identifier within that source ('2244', 'CHEMBL25'). */
  readonly sourceId: string
  /** Preferred display name — absent when the source supplies none. */
  readonly name?: string
  readonly synonyms: readonly string[]
  readonly identifiers: CompoundIdentifiers
  readonly provenance: SourceAttribution
  /** ISO 8601 bookkeeping stamps assigned at import time. */
  readonly createdAt: string
  readonly updatedAt: string
}

/**
 * A compound as returned by a source adapter — the same shape the
 * repository persists; only the storage bookkeeping stamps are added at
 * import time.
 */
export type RemoteCompound = Compound

/**
 * Stable record identity. Derived only from the authoritative source id,
 * so re-importing the same external record yields the same key (duplicate
 * detection never depends on names).
 */
export function compoundId(source: string, sourceId: string): string {
  return `${source}:${sourceId}`
}
