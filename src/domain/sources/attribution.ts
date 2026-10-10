/**
 * Source attribution shared by every record acquired from an external
 * data source (Layer A compounds and Layer B observations).
 *
 * This is the answer to "where did this record come from?" — which source
 * supplied it, which external record identifier it carries, the URL that
 * identifies that record, when it was retrieved, and the source's
 * applicable licensing/attribution notice. Fields the source does not
 * supply stay absent; nothing here is ever invented.
 *
 * Pure domain module: no React, no I/O, no schema imports.
 */
import type { IsoDateTime } from '../provenance/provenance'

export interface SourceAttribution {
  /** Adapter id that supplied the record (e.g. 'pubchem', 'chembl'). */
  readonly source: string
  /** Display name of the source (e.g. 'PubChem', 'ChEMBL'). */
  readonly sourceName: string
  /** External record identifier exactly as the source identifies it. */
  readonly recordId: string
  /** Source URL identifying this exact record. */
  readonly url: string
  /** When this record was retrieved from the source (ISO 8601). */
  readonly retrievedAt: IsoDateTime
  /** Source release/record version — only when the source supplies one. */
  readonly sourceVersion?: string
  /** Human-readable licensing/attribution notice, when applicable. */
  readonly licenseNotice?: string
  /** Link to the source's licensing, terms or attribution page. */
  readonly licenseUrl?: string
}
