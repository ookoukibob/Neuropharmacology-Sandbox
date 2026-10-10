/**
 * Bounded HTTP JSON retrieval.
 *
 * Every external request goes through this one function so the policy is
 * uniform and testable:
 *
 * - **timeout** — each attempt has a fixed budget (default 10 s) so a
 *   hung endpoint cannot stall the UI indefinitely;
 * - **cancellation** — a caller-supplied AbortSignal aborts the in-flight
 *   request immediately and rejects with code `aborted` (used for stale
 *   searches and unmounts);
 * - **controlled retries** — network failures and 5xx responses are
 *   retried once (default) with a short delay; 4xx answers, timeouts and
 *   cancellations are never retried, so a bad query or a slow endpoint is
 *   reported promptly instead of hammered;
 * - **honest errors** — non-2xx statuses carry their status code (and the
 *   source's own fault message when the body has one); a body that is not
 *   JSON is `invalid-response`, never a generic failure.
 *
 * No request is ever issued by this module on its own — callers pass the
 * URL, so startup and navigation paths stay network-free.
 */
import { SourceRequestError, type FetchLike } from './types'

export const DEFAULT_TIMEOUT_MS = 10_000
/** Extra attempts after the first (network / 5xx only). */
export const DEFAULT_RETRIES = 1
export const DEFAULT_RETRY_DELAY_MS = 300

export interface FetchJsonOptions {
  readonly fetchFn?: FetchLike
  readonly signal?: AbortSignal
  readonly headers?: Readonly<Record<string, string>>
  readonly timeoutMs?: number
  readonly retries?: number
  readonly retryDelayMs?: number
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function attemptOnce(url: string, options: FetchJsonOptions): Promise<unknown> {
  const fetchFn = options.fetchFn ?? defaultFetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const external = options.signal

  if (external?.aborted === true) {
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
      if (cancelled) {
        throw new SourceRequestError('aborted', 'request was cancelled')
      }
      if (timedOut) {
        throw new SourceRequestError('timeout', `request exceeded ${timeoutMs} ms`)
      }
      throw new SourceRequestError(
        'network',
        error instanceof Error ? error.message : String(error),
      )
    }

    if (!response.ok) {
      let detail: string | undefined
      try {
        detail = faultDetail(await response.json())
      } catch {
        // Non-JSON error body — the status code alone carries the meaning.
      }
      throw new SourceRequestError(
        'http',
        `HTTP ${response.status}${detail !== undefined ? `: ${detail}` : ''}`,
        response.status,
      )
    }

    try {
      return (await response.json()) as unknown
    } catch {
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
 */
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const retries = options.retries ?? DEFAULT_RETRIES
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS
  let extraAttempts = 0
  for (;;) {
    try {
      return await attemptOnce(url, options)
    } catch (error) {
      if (!(error instanceof SourceRequestError)) throw error
      if (error.code === 'aborted') throw error
      const retryable =
        error.code === 'network' || (error.code === 'http' && (error.status ?? 0) >= 500)
      if (!retryable || extraAttempts >= retries) throw error
      extraAttempts += 1
      if (retryDelayMs > 0) await delay(retryDelayMs)
    }
  }
}
