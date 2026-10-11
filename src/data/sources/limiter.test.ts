/**
 * Rate-limiter and cancellation-aware wait tests. Everything is
 * deterministic: injected clock and injected/manual waits — no real
 * network and no reliance on real timing. (One abortableDelay test uses
 * a real 1 ms timer purely to prove the default wiring resolves.)
 */
import { describe, expect, it } from 'vitest'
import { abortableDelay, createRateLimiter } from './limiter'

/** A limiter whose clock only moves when a wait runs (auto-advancing). */
function manualLimiter(minIntervalMs = 250) {
  const clock = { value: 0 }
  const waits: number[] = []
  const limiter = createRateLimiter({
    minIntervalMs,
    now: () => clock.value,
    delay: async (ms) => {
      waits.push(ms)
      clock.value += ms
    },
  })
  return { limiter, waits, clock }
}

/** A limiter whose waits only settle when the test releases them. */
function gatedLimiter(minIntervalMs = 250) {
  const clock = { value: 0 }
  const pending: { readonly ms: number; readonly resolve: () => void }[] = []
  const limiter = createRateLimiter({
    minIntervalMs,
    now: () => clock.value,
    delay: (ms) =>
      new Promise<void>((resolve) => {
        pending.push({ ms, resolve })
      }),
  })
  return { limiter, pending, clock }
}

describe('createRateLimiter — spacing', () => {
  it('grants request starts at least minIntervalMs apart', async () => {
    const { limiter, waits } = manualLimiter(250)
    await limiter.acquire() // first start is immediate
    await limiter.acquire()
    await limiter.acquire()
    expect(waits).toEqual([250, 250])
  })

  it('does not delay a request when the interval has already elapsed', async () => {
    const { limiter, waits, clock } = manualLimiter(250)
    await limiter.acquire()
    clock.value += 1000 // slow caller — the window elapsed on its own
    await limiter.acquire()
    expect(waits).toEqual([])
  })

  it('spaces the next request from the last granted start after a failure — no bypass', async () => {
    const { limiter, waits, clock } = manualLimiter(250)
    await limiter.acquire() // a request starts, then fails at the network layer
    clock.value += 5 // 5 ms pass before the failure is noticed
    await limiter.acquire() // still waits the remainder of the interval: 245
    expect(waits).toEqual([245])
  })

  it('keeps grants in FIFO order', async () => {
    const { limiter, pending } = gatedLimiter(250)
    const order: string[] = []
    const first = limiter.acquire().then(() => {
      order.push('first')
    })
    const second = limiter.acquire().then(() => {
      order.push('second')
    })
    const third = limiter.acquire().then(() => {
      order.push('third')
    })
    await first
    expect(order).toEqual(['first'])
    expect(pending).toHaveLength(1) // second is waiting for its slot
    pending[0]?.resolve()
    await second
    expect(order).toEqual(['first', 'second'])
    expect(pending).toHaveLength(2) // third waited behind second
    pending[1]?.resolve()
    await third
    expect(order).toEqual(['first', 'second', 'third'])
  })
})

describe('createRateLimiter — cancellation', () => {
  it('rejects a queued request whose signal fires, without ever granting it', async () => {
    const { limiter, pending } = gatedLimiter(250)
    await limiter.acquire() // grant 1
    const controller = new AbortController()
    const queued = limiter.acquire(controller.signal) // queued behind grant 1
    controller.abort()
    await expect(queued).rejects.toMatchObject({ code: 'aborted' })
    pending[0]?.resolve() // the abandoned wait settles; no late grant appears
    await Promise.resolve() // flush the recovery microtask
  })

  it('a cancelled waiter consumes no slot — the next request waits only the real interval', async () => {
    const { limiter, waits } = manualLimiter(250)
    await limiter.acquire() // grant 1 at t=0
    const controller = new AbortController()
    const cancelled = limiter.acquire(controller.signal)
    controller.abort() // aborted while queued (its grant runs on a later microtask)
    await expect(cancelled).rejects.toMatchObject({ code: 'aborted' })
    await limiter.acquire() // only the interval since grant 1 — no doubled gap
    expect(waits).toEqual([250])
  })

  it('rejects immediately for an already-aborted signal, without a wait', async () => {
    const { limiter, waits } = manualLimiter(250)
    const controller = new AbortController()
    controller.abort()
    await expect(limiter.acquire(controller.signal)).rejects.toMatchObject({ code: 'aborted' })
    expect(waits).toEqual([])
  })
})

describe('createRateLimiter — isolation', () => {
  it('one limiter instance does not affect another (no leaked queue state)', async () => {
    const a = manualLimiter(250)
    const b = manualLimiter(250)
    await a.limiter.acquire()
    await a.limiter.acquire() // a waits one interval after its own first grant
    await b.limiter.acquire() // a fresh instance is granted immediately —
    // no spacing inherited from a's queue state
    expect(a.waits).toEqual([250])
    expect(b.waits).toEqual([])
  })
})

describe('abortableDelay', () => {
  it('resolves after the delay', async () => {
    await expect(abortableDelay(1)).resolves.toBeUndefined()
  })

  it('rejects with aborted when the signal fires during the wait', async () => {
    const controller = new AbortController()
    const waiting = abortableDelay(10_000, controller.signal)
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'aborted' })
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(abortableDelay(10_000, controller.signal)).rejects.toMatchObject({
      code: 'aborted',
    })
  })
})
