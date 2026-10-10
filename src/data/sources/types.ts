/**
 * Source-adapter contracts: bounded, cancellable retrieval of external
 * records behind one reusable interface. HTTP, parsing, normalization and
 * persistence stay separated — adapters know the wire format, the
 * repository knows storage, and neither knows the UI.
 *
 * Every failure a retrieval can produce is normalized to a
 * `SourceRequestError` with one of these codes, so the UI can always
 * explain what went wrong instead of showing a generic failure:
 * - `network`          — the request never completed (connection lost);
 * - `timeout`          — bounded wait exceeded;
 * - `aborted`          — cancelled by the user or superseded by a newer search;
 * - `http`             — the source answered with an error status;
 * - `invalid-response` — the body was not JSON or did not match the shape
 *                        this version understands (remote JSON is never
 *                        trusted because it compiled).
 */
import type { RemoteCompound } from '../../domain/sources/compound'
import type { RemoteObservation } from '../../domain/sources/observation'

export type SourceErrorCode =
  | 'network'
  | 'timeout'
  | 'aborted'
  | 'http'
  | 'invalid-response'

export class SourceRequestError extends Error {
  readonly code: SourceErrorCode
  readonly status: number | undefined

  constructor(code: SourceErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'SourceRequestError'
    this.code = code
    this.status = status
  }
}

/**
 * Minimal fetch signature used throughout the data-source layer. HTTP is
 * always injected (composition root passes a real `fetch`, tests pass a
 * scripted fake), so adapters never reach for globals directly and CI
 * never needs live network.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface RequestOptions {
  /** Cancellation link — an aborted signal rejects with code 'aborted'. */
  readonly signal?: AbortSignal
}

/** Options for one page of experimental observations. */
export interface ObservationRequestOptions extends RequestOptions {
  readonly limit?: number
  readonly offset?: number
  /**
   * `parameters` retrieves only the endpoints that map onto a model
   * parameter slot (the adapter's documented set); `all` retrieves every
   * endpoint type the source reports.
   */
  readonly endpointScope?: 'parameters' | 'all'
}

/** One search scope a source may offer. */
export type SearchScope = 'compounds' | 'targets'

/** A target as returned by a target search (transient, not persisted). */
export interface RemoteTarget {
  readonly sourceTargetId: string
  readonly name?: string
  readonly organism?: string
  readonly targetType?: string
}

/** One page of observations plus honest pagination bookkeeping. */
export interface ObservationPage {
  readonly items: readonly RemoteObservation[]
  /** Total matching records at the source, when the source supplies one. */
  readonly total: number | null
  /** Next offset for pagination, or null when this is the last page. */
  readonly nextOffset: number | null
  /**
   * Supplied records that carried no usable measurement (missing value or
   * endpoint) or did not validate — counted, never silently hidden.
   */
  readonly omitted: number
}

/**
 * One external source behind a reusable interface. Capabilities drive the
 * UI: a source without target search or without an observation endpoint
 * simply does not offer those controls (PubChem provides compound
 * identity in this version — it is not misrepresented as an activity
 * source).
 */
export interface SourceAdapter {
  /** Adapter id, also the `source` field of every record it supplies. */
  readonly id: string
  /** Display name ('PubChem', 'ChEMBL'). */
  readonly name: string
  /** One-line description shown in the source picker. */
  readonly description: string
  readonly capabilities: {
    readonly searchScopes: readonly SearchScope[]
    readonly observations: boolean
  }
  /** Static licensing/attribution notice stamped onto supplied records. */
  readonly licenseNotice?: string
  readonly licenseUrl?: string

  /** Compound/identifier search → identity records (validated by mapping). */
  searchCompounds(query: string, options: RequestOptions): Promise<readonly RemoteCompound[]>
  /** Target search (only when the source offers the capability). */
  searchTargets?(query: string, options: RequestOptions): Promise<readonly RemoteTarget[]>
  /**
   * First/later page of observations reported for one compound at the
   * source (only when the source offers an observation endpoint).
   * Retrieval is user-initiated only — adapters never poll.
   */
  fetchObservations?(
    compoundSourceId: string,
    options?: ObservationRequestOptions,
  ): Promise<ObservationPage>
  /** Observations reported for one target (only when offered). */
  fetchObservationsByTarget?(
    targetSourceId: string,
    options?: ObservationRequestOptions,
  ): Promise<ObservationPage>
  /**
   * Batch resolution of full compound identity records by source id —
   * used when observations are imported from a target search and their
   * compounds still need Layer A records.
   */
  fetchCompounds?(
    sourceIds: readonly string[],
    options?: RequestOptions,
  ): Promise<readonly RemoteCompound[]>
}
