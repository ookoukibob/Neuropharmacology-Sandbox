/**
 * Source-adapter registry — the one place that decides which external
 * sources this build offers and in which order the picker shows them.
 *
 * Adapters are created here with default dependencies (the platform
 * `fetch`, the real clock); tests construct adapters directly with
 * injected fakes instead of going through this module, so the registry
 * itself is trivial and CI never performs live calls.
 *
 * Adding a source later = one more `SourceAdapter` in this list; the UI
 * derives its source picker and capabilities from the list without
 * hardcoding names.
 */
import { createChEMBLAdapter } from './chembl'
import { createPubChemAdapter } from './pubchem'
import type { FetchLike, SourceAdapter } from './types'

export interface SourceRegistryOptions {
  /** Injected transport (default: the platform fetch). */
  readonly fetchFn?: FetchLike
  /** Injected clock for retrieval timestamps (default: real time). */
  readonly now?: () => string
}

/** All sources this build can reach, in picker order. */
export function createSourceAdapters(
  options: SourceRegistryOptions = {},
): readonly SourceAdapter[] {
  const shared = {
    ...(options.fetchFn !== undefined ? { fetchFn: options.fetchFn } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  }
  return [createPubChemAdapter(shared), createChEMBLAdapter(shared)]
}
