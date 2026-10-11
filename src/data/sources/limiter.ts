/**
 * Request pacing (rate limiting) and cancellation-aware waiting.
 *
 * PubChem's usage policy asks clients for at most 5 requests per second;
 * this module provides the one in-memory pacer the PubChem adapter uses
 * to stay below that line (4 request starts per second by default).
 *
 * Scope — stated honestly: one `RateLimiter` instance coordinates the
 * callers that share it (in this application: every PubChem request made
 * through the adapters created by one `createSourceAdapters()` call). It
 * is in-memory only — it does not coordinate other browser tabs,
 * independent browser profiles, or other devices, and it holds no
 * persistent state.
 *
 * Semantics:
 * - grants are serialized in FIFO order and start at least
 *   `minIntervalMs` apart;
 * - a caller waiting in the queue can be cancelled with its
 *   `AbortSignal`; the cancellation rejects with code `aborted` and the
 *   request never reaches the network;
 * - a cancelled or failed caller never consumes a slot, so a later
 *   request is spaced from the last GRANTED start — cancellation and
 *   failure do not bypass the limit, and they do not leave phantom gaps
 *   that would delay unrelated requests.
 */
import { SourceRequestError } from './types'

/**
 * Wait `ms`, rejecting early with code `aborted` when the signal fires
 * during the wait. Used for both retry delays and queue waits, so a
 * cancelled request never sits out an unconditional delay.
 */
export function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new SourceRequestError('aborted', 'cancelled while waiting'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new SourceRequestError('aborted', 'cancelled while waiting'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export interface RateLimiterOptions {
  /** Minimum time between two granted request starts, in milliseconds. */
  readonly minIntervalMs: number
  /** Injected clock (default: `Date.now`) for deterministic tests. */
  readonly now?: () => number
  /** Injected wait (default: `abortableDelay`) for deterministic tests. */
  readonly delay?: (ms: number, signal?: AbortSignal) => Promise<void>
}

export interface RateLimiter {
  /**
   * Resolve when the caller may start its request. FIFO-ordered; waits
   * out the spacing since the last granted start; rejects with code
   * `aborted` if the signal fires while queued (and then never grants).
   */
  acquire(signal?: AbortSignal): Promise<void>
}

/** A fresh in-memory pacer. Each instance is fully independent. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { minIntervalMs, now = Date.now, delay = abortableDelay } = options
  let lastGrantAt: number | null = null
  let tail: Promise<unknown> = Promise.resolve()

  return {
    acquire(signal?: AbortSignal): Promise<void> {
      const grant = tail.then(async () => {
        if (signal?.aborted === true) {
          throw new SourceRequestError('aborted', 'cancelled while queued for a request slot')
        }
        const earliest = lastGrantAt === null ? now() : lastGrantAt + minIntervalMs
        const waitMs = Math.max(0, earliest - now())
        if (waitMs > 0) {
          await delay(waitMs, signal) // rejects with 'aborted' on cancellation
        }
        lastGrantAt = now()
      })
      // The next waiter continues after a rejection, but a rejected
      // waiter never granted a slot, so it does not shift spacing.
      tail = grant.catch(() => undefined)
      return grant
    },
  }
}
