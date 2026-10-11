/**
 * Request pacing (rate limiting) and cancellation-aware waiting.
 *
 * PubChem's usage policy asks clients for at most 5 requests per second;
 * this module provides the one in-memory pacer the PubChem adapter uses
 * to stay below that line (4 request starts per second by default).
 *
 * Scope — stated honestly: one `RateLimiter` instance coordinates the
 * callers that share it (in this application: every PubChem HTTP ATTEMPT
 * — initial requests and automatic retries alike — made through the
 * adapters created by one `createSourceAdapters()` call). It is
 * in-memory only — it does not coordinate other browser tabs,
 * independent browser profiles, or other devices, and it holds no
 * persistent state.
 *
 * Semantics:
 * - grants are serialized in FIFO order and start at least
 *   `minIntervalMs` apart; the queue is explicit, so an entry can be
 *   removed while others keep waiting;
 * - a caller waiting anywhere in the queue can be cancelled with its
 *   `AbortSignal`; the promise rejects PROMPTLY with code `aborted`
 *   (it does not wait for earlier entries to settle), the entry is
 *   removed from the queue, and no request ever reaches the network;
 * - a cancelled entry never consumes a permit and never shifts the
 *   permitted start time of the survivors; a failed attempt that DID
 *   start keeps its interval (it was a real request start);
 * - the queue only ever contains caller-initiated attempts of this
 *   runtime (there are no background requests), and cancellation is the
 *   bounded way out of it.
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
   * `aborted` the moment its signal fires while queued — regardless of
   * how many other entries are still waiting ahead of it — and is then
   * removed from the queue without granting or shifting spacing.
   */
  acquire(signal?: AbortSignal): Promise<void>
}

interface QueueEntry {
  readonly signal: AbortSignal | undefined
  readonly resolve: () => void
  readonly reject: (error: unknown) => void
  settled: boolean
  removeListener: () => void
}

/** A fresh in-memory pacer. Each instance is fully independent. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { minIntervalMs, now = Date.now, delay = abortableDelay } = options
  let lastGrantAt: number | null = null
  const queue: QueueEntry[] = []
  // The cycle currently serving the head entry (waiting for its slot),
  // or null when the queue head is unclaimed. Used to make a cancelled
  // head's late wait-resolution a no-op instead of a phantom grant.
  let active: { readonly entry: QueueEntry; readonly waitController: AbortController } | null = null

  function settle(entry: QueueEntry): boolean {
    if (entry.settled) return false
    entry.settled = true
    entry.removeListener()
    const index = queue.indexOf(entry)
    if (index >= 0) queue.splice(index, 1)
    return true
  }

  function pump(): void {
    if (active !== null) return
    const head = queue[0]
    if (head === undefined) return
    const waitController = new AbortController()
    active = { entry: head, waitController }
    const finish = (granted: boolean): void => {
      // A cancelled head's cycle may resolve late (a custom delay that
      // ignores the wait signal) — only the cycle that still owns the
      // head may touch pacing state.
      if (active?.entry !== head) return
      active = null
      if (granted && !head.settled) {
        lastGrantAt = now()
        settle(head)
        head.resolve()
      }
      pump()
    }
    const earliest = lastGrantAt === null ? now() : lastGrantAt + minIntervalMs
    const waitMs = Math.max(0, earliest - now())
    if (waitMs <= 0) {
      finish(true)
      return
    }
    delay(waitMs, waitController.signal).then(
      () => {
        finish(true)
      },
      () => {
        finish(false) // the head was cancelled while waiting for its slot
      },
    )
  }

  return {
    acquire(signal?: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) {
          reject(new SourceRequestError('aborted', 'cancelled while queued for a request slot'))
          return
        }
        const entry: QueueEntry = {
          signal,
          resolve,
          reject,
          settled: false,
          removeListener: () => {},
        }
        if (signal !== undefined) {
          const onAbort = (): void => {
            // Prompt: reject and remove THIS entry no matter where it is
            // in the queue; if it is the head, stop its pending wait too.
            if (!settle(entry)) return
            if (active?.entry === entry) {
              const cycle = active
              active = null
              cycle.waitController.abort()
            }
            entry.reject(new SourceRequestError('aborted', 'cancelled while queued for a request slot'))
            pump()
          }
          signal.addEventListener('abort', onAbort, { once: true })
          entry.removeListener = (): void => {
            signal.removeEventListener('abort', onAbort)
          }
        }
        queue.push(entry)
        pump()
      })
    },
  }
}
