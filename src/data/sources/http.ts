/**
 * Bounded HTTP JSON retrieval.
 *
 * Every external request goes through this one function so the policy is
 * uniform and testable:
 *
 * - **timeout** — each attempt has a fixed budget (default 10 s) so a
 *   hung endpoint cannot stall the UI indefinitely; the budget covers
 *   the fetch and the response-body read, but NOT the wait for a
 *   `beforeAttempt` permit (that wait is bounded by the pacer's FIFO
 *   spacing and by cancellation, not by this timer);
 * - **cancellation** — a caller-supplied AbortSignal aborts the in-flight
 *   request immediately and rejects with code `aborted` (used for stale
 *   searches and unmounts). The wait between retries is cancellation-aware
 *   too: a cancelled request never starts another attempt;
 * - **per-attempt hook** — `beforeAttempt` is awaited before EVERY attempt
 *   (the initial one and every automatic retry), so a pacer injected
 *   through it spaces actual request starts; an attempt whose hook
 *   rejects (e.g. cancelled while queued) never reaches the network;
 * - **controlled retries** — network failures, 5xx answers and HTTP 429
 *   (throttling) are retried once (default) after a short delay; every
 *   other 4xx answer, timeout and cancellation is never retried, so a bad
 *   query or a slow endpoint is reported promptly instead of hammered;
 * - **bounded Retry-After** — when a retryable answer supplies a valid
 *   `Retry-After` header, the wait honours it up to a small cap
 *   (`maxRetryAfterMs`, default 2 s); a longer server-requested wait fails
 *   fast with the status and the requested wait attached instead of
 *   stalling the UI;
 * - **honest errors** — non-2xx statuses carry their status code (and the
 *   source's own fault message when the body has one); a body that is not
 *   JSON is `invalid-response`, never a generic failure. Cancellation and
 *   the timeout budget keep their typed codes (`aborted` / `timeout`) even
 *   when they strike while a response body is being read, and a body-read
 *   cancellation never degrades into a plain HTTP or parsing error.
 *
 * No request is ever issued by this module on its own — callers pass the
 * URL, so startup and navigation paths stay network-free.
 */
import { abortableDelay } from './limiter'
import { SourceRequestError, type FetchLike } from './types'

export const DEFAULT_TIMEOUT_MS = 10_000
/** Extra attempts after the first (network / 5xx / 429 only). */
export const DEFAULT_RETRIES = 1
export const DEFAULT_RETRY_DELAY_MS = 300
/** Upper bound for a server-supplied `Retry-After` wait. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 2_000

export interface FetchJsonOptions {
  readonly fetchFn?: FetchLike
  readonly signal?: AbortSignal
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelayMs?: number
  /** Upper bound for a server-supplied `Retry-After` (default 2 s). */
  readonly maxRetryAfterMs?: number
  /** Injected wait between attempts — deterministic tests. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /**
   * Awaited before EVERY attempt (initial and each retry), before the
   * attempt's timeout budget starts — e.g. a rate-limiter permit
   * acquisition. A rejection (typically `aborted`) prevents that attempt
   * from reaching the network and surfaces as the typed error.
   */
  readonly beforeAttempt?: (signal?: AbortSignal) => Promise<void>
}

const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init)

/** Pull a source-supplied fault message out of an error body, if present. */
function faultDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const fault = (body as Record<string, unknown>)['Fault']
  if (typeof fault === 'object' && fault !== null) {
    const message = (fault as Record<string, unknown>)['Message']
    if (typeof message === 'string' && message.length > 0) return message
  }
  return undefined
}

/**
 * Parse a `Retry-After` header (delta-seconds or HTTP-date) into
 * milliseconds; `null` when absent or unparseable (then the caller uses
 * its own fixed delay).
 */
export function parseRetryAfterMs(header: string | null, now: () => number = Date.now): number | null {
  if (header === null) return null
  const value = header.trim()
  if (/^\d+$/.test(value)) return Number(value) * 1000
  const atMs = Date.parse(value)
  if (Number.isNaN(atMs)) return null
  return Math.max(0, atMs - now())
}

/**
 * Who aborted a body read: the caller (cancel/stale) or the timeout
 * budget — or nobody (`undefined`, a genuine parse failure).
 */
function bodyReadInterrupt(
  cancelled: boolean,
  timedOut: boolean,
  timeoutMs: number,
): SourceRequestError | undefined {
  if (cancelled) return new SourceRequestError('aborted', 'request was cancelled')
  if (timedOut) return new SourceRequestError('timeout', `request exceeded ${timeoutMs} ms`)
  return undefined
}

/** `signal?.aborted`, immune to control-flow narrowing across awaits. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

async function attemptOnce(url: string, options: FetchJsonOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? defaultFetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const external = options.signal

  if (isAborted(external)) {
    throw new SourceRequestError('aborted', 'request was cancelled')
  }

  // Per-attempt pacing/permit hook — deliberately OUTSIDE the attempt's
  // timeout budget: waiting for a rate-limit slot is bounded by the
  // pacer's FIFO spacing and by cancellation, not by this timer.
  await options.beforeAttempt?.(external)
  if (isAborted(external)) {
    // The permit may have been granted just as the caller cancelled —
    // never start the network request after that.
    throw new SourceRequestError('aborted', 'request was cancelled')
  }

  const controller = new AbortController()
  let cancelled = false
  const onExternalAbort = (): void => {
    cancelled = true
    controller.abort()
  }
  external?.addEventListener('abort', onExternalAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let response: Response
    try {
      response = await fetchFn(url, {
        signal: controller.signal,
        ...(options.headers !== undefined ? { headers: { ...options.headers } } : {}),
      })
    } catch (error) {
      // Distinguish who aborted: the caller (cancel/stale), the timeout
      // budget, or an honest network failure.
      const interrupt = bodyReadInterrupt(cancelled, timedOut, timeoutMs)
      if (interrupt !== undefined) throw interrupt
      throw new SourceRequestError(
        'network',
        error instanceof Error ? error.message : String(error),
      )
    }

    if (!response.ok) {
      let detail: string | undefined
      try {
        detail = faultDetail(await response.json())
      } catch (error) {
        // Cancellation or timeout while reading the error body keep
        // their typed codes — they are not "just" an HTTP error and are
        // never downgraded to the status or to a parsing failure.
        const interrupt = bodyReadInterrupt(cancelled, timedOut, timeoutMs)
        if (interrupt !== undefined) throw interrupt
        if (error instanceof SourceRequestError) throw error
        // Non-JSON error body — the status code alone carries the meaning.
      }
      const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After')) ?? undefined
      throw new SourceRequestError(
        'http',
        `HTTP ${response.status}${detail !== undefined ? `: ${detail}` : ''}`,
        response.status,
        retryAfterMs,
      )
    }

    try {
      return (await response.json()) as unknown
    } catch (error) {
      // Same classification for the success path: a cancelled or timed
      // out body read keeps its typed code; only a genuine parse
      // failure is invalid-response.
      const interrupt = bodyReadInterrupt(cancelled, timedOut, timeoutMs)
      if (interrupt !== undefined) throw interrupt
      if (error instanceof SourceRequestError) throw error
      throw new SourceRequestError('invalid-response', 'response body was not valid JSON')
    }
  } finally {
    clearTimeout(timer)
    external?.removeEventListener('abort', onExternalAbort)
  }
}

/**
 * GET `url` and parse the JSON body, applying the timeout / retry /
 * cancellation policy above. Rejects only with `SourceRequestError`, so
 * callers can map every failure to an explained, source-specific message.
 * `options.beforeAttempt` is invoked for every attempt — the initial one
 * and each automatic retry — so an injected pacer (e.g. the PubChem
 * limiter) spaces actual request starts, retries included.
 */
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS
  const sleep = options.sleep ?? abortableDelay
  let extraAttempts = 0
  for (;;) {
    try {
      return await attemptOnce(url, options)
    } catch (error) {
      if (!(error instanceof SourceRequestError)) throw error
      if (error.code === 'aborted') throw error
      const retryable =
        error.code === 'network' ||
        (error.code === 'http' && ((error.status ?? 0) >= 500 || error.status === 429))
      if (!retryable || extraAttempts >= retries) throw error
      extraAttempts += 1
      if (error.retryAfterMs !== undefined && error.retryAfterMs > maxRetryAfterMs) {
        // Deliberate: a long server-requested wait must not stall the UI.
        // Fail fast with the status and the requested wait attached.
        throw error
      }
      const waitMs = error.retryAfterMs ?? retryDelayMs
      if (waitMs > 0) await sleep(waitMs, options.signal) // rejects with 'aborted' on cancel
    }
  }
}
