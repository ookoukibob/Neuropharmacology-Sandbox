/**
 * Transport policy tests: bounded timeouts, cancellation, controlled
 * retries and honest error codes. No live network anywhere — every
 * response is scripted through an injected fake fetch.
 * All URLs and payloads here are synthetic test data.
 */
import { describe, expect, it, vi } from 'vitest'
import { fetchJson, parseRetryAfterMs } from './http'
import { SourceRequestError, type FetchLike } from './types'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * A Response whose `json()` settles only when the test says so — lets a
 * test interrupt (cancel / time out / fail) DURING the body read.
 */
function controllableJson(status = 200): {
  readonly response: Response
  readonly succeedJson: (body: unknown) => void
  readonly failJson: (error: unknown) => void
} {
  let succeed: (body: unknown) => void = () => {}
  let fail: (error: unknown) => void = () => {}
  const body = new Promise<unknown>((resolve, reject) => {
    succeed = resolve
    fail = reject
  })
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: () => body,
  } as unknown as Response
  return {
    response,
    succeedJson: (value) => {
      succeed(value)
    },
    failJson: (error) => {
      fail(error)
    },
  }
}

/** A fetch that delivers `response` and signals when it has been called. */
function gatedFetch(response: Response): {
  readonly fetchFn: FetchLike
  readonly called: Promise<void>
} {
  let mark: () => void = () => {}
  const called = new Promise<void>((resolve) => {
    mark = resolve
  })
  const fetchFn: FetchLike = async () => {
    mark()
    return response
  }
  return { fetchFn, called }
}

function recorder(handler: (url: string) => Response | Promise<Response>): {
  readonly fetchFn: FetchLike
  readonly urls: string[]
} {
  const urls: string[] = []
  const fetchFn: FetchLike = async (url) => {
    urls.push(url)
    return await handler(url)
  }
  return { fetchFn, urls }
}

async function rejection(promise: Promise<unknown>): Promise<SourceRequestError> {
  try {
    await promise
  } catch (error) {
    if (error instanceof SourceRequestError) return error
    throw error
  }
  throw new Error('expected the request to reject')
}

describe('fetchJson — success and body handling', () => {
  it('parses and returns a JSON body', async () => {
    const { fetchFn, urls } = recorder(() => json({ ok: true, n: 1 }))
    await expect(fetchJson('https://source.test/data', { fetchFn })).resolves.toEqual({
      ok: true,
      n: 1,
    })
    expect(urls).toEqual(['https://source.test/data'])
  })

  it('rejects a non-JSON body as invalid-response without retrying', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return new Response('<html>nope</html>', { status: 200 })
    }
    const error = await rejection(
      fetchJson('https://source.test/data', { fetchFn, retryDelayMs: 0 }),
    )
    expect(error.code).toBe('invalid-response')
    expect(calls).toBe(1)
  })
})

describe('fetchJson — HTTP errors', () => {
  it('carries the status code and the source fault message', async () => {
    const { fetchFn } = recorder(() =>
      json({ Fault: { Code: 'PUGREST.NotFound', Message: 'No CID found' } }, 404),
    )
    const error = await rejection(fetchJson('https://source.test/lookup', { fetchFn }))
    expect(error.code).toBe('http')
    expect(error.status).toBe(404)
    expect(error.message).toContain('No CID found')
  })

  it('retries a 5xx once and succeeds', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return calls === 1 ? json({}, 503) : json({ ok: true })
    }
    await expect(
      fetchJson('https://source.test/data', { fetchFn, retryDelayMs: 0 }),
    ).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('gives up after the retry budget on a persistent 5xx', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return json({}, 500)
    }
    const error = await rejection(
      fetchJson('https://source.test/data', { fetchFn, retryDelayMs: 0 }),
    )
    expect(error.code).toBe('http')
    expect(error.status).toBe(500)
    expect(calls).toBe(2) // one attempt + one retry
  })

  it('never retries a 4xx answer', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return json({}, 400)
    }
    const error = await rejection(
      fetchJson('https://source.test/data', { fetchFn, retryDelayMs: 0 }),
    )
    expect(error.code).toBe('http')
    expect(error.status).toBe(400)
    expect(calls).toBe(1)
  })
})

describe('fetchJson — network failure, timeout, cancellation', () => {
  it('reports a connection failure as network and retries once', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      if (calls === 1) throw new TypeError('connection reset')
      return json({ ok: true })
    }
    await expect(
      fetchJson('https://source.test/data', { fetchFn, retryDelayMs: 0 }),
    ).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('times out a hanging request without retrying it', async () => {
    let calls = 0
    const fetchFn: FetchLike = (_url, init) => {
      calls += 1
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    }
    const error = await rejection(
      fetchJson('https://source.test/hang', { fetchFn, timeoutMs: 10, retryDelayMs: 0 }),
    )
    expect(error.code).toBe('timeout')
    expect(calls).toBe(1)
  })

  it('rejects immediately with aborted when the caller cancelled first', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchFn, urls } = recorder(() => json({}))
    const error = await rejection(
      fetchJson('https://source.test/data', { fetchFn, signal: controller.signal }),
    )
    expect(error.code).toBe('aborted')
    expect(urls).toEqual([])
  })

  it('rejects with aborted when cancelled while in flight', async () => {
    const controller = new AbortController()
    const fetchFn: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        })
      })
    const pending = fetchJson('https://source.test/data', {
      fetchFn,
      signal: controller.signal,
    })
    controller.abort()
    const error = await rejection(pending)
    expect(error.code).toBe('aborted')
  })

  it('does not start another attempt after cancellation during the retry wait', async () => {
    const controller = new AbortController()
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      setTimeout(() => controller.abort(), 5) // cancels during the retry wait
      return json({}, 503)
    }
    const error = await rejection(
      fetchJson('https://source.test/data', {
        fetchFn,
        signal: controller.signal,
        retryDelayMs: 10_000, // would wait 10 s — cancellation must cut it short
      }),
    )
    expect(error.code).toBe('aborted')
    expect(calls).toBe(1) // the cancelled request never reached a second fetch
  })
})

describe('fetchJson — throttling answers (429 / Retry-After)', () => {
  it('retries a 429 once and succeeds', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return calls === 1 ? json({}, 429) : json({ ok: true })
    }
    await expect(
      fetchJson('https://source.test/data', { fetchFn, retryDelayMs: 0 }),
    ).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  it('honours a bounded Retry-After before the retry (deterministic, injected wait)', async () => {
    let calls = 0
    const waits: number[] = []
    const fetchFn: FetchLike = async () => {
      calls += 1
      return calls === 1
        ? new Response('{}', { status: 429, headers: { 'Retry-After': '2' } })
        : json({ ok: true })
    }
    await expect(
      fetchJson('https://source.test/data', {
        fetchFn,
        retryDelayMs: 0,
        sleep: async (ms) => {
          waits.push(ms)
        },
      }),
    ).resolves.toEqual({ ok: true })
    expect(waits).toEqual([2000])
    expect(calls).toBe(2)
  })

  it('fails fast with the status instead of stalling on a long Retry-After', async () => {
    let calls = 0
    const waits: number[] = []
    const fetchFn: FetchLike = async () => {
      calls += 1
      return new Response('{}', { status: 429, headers: { 'Retry-After': '120' } })
    }
    const error = await rejection(
      fetchJson('https://source.test/data', {
        fetchFn,
        sleep: async (ms) => {
          waits.push(ms)
        },
      }),
    )
    expect(error.code).toBe('http')
    expect(error.status).toBe(429)
    expect(error.retryAfterMs).toBe(120_000) // preserved for honest messaging
    expect(calls).toBe(1) // no retry, no wait
    expect(waits).toEqual([])
  })

  it('ignores an unparseable Retry-After and uses the fixed delay', async () => {
    let calls = 0
    const waits: number[] = []
    const fetchFn: FetchLike = async () => {
      calls += 1
      return calls === 1
        ? new Response('{}', { status: 503, headers: { 'Retry-After': 'later' } })
        : json({ ok: true })
    }
    await expect(
      fetchJson('https://source.test/data', {
        fetchFn,
        retryDelayMs: 7,
        sleep: async (ms) => {
          waits.push(ms)
        },
      }),
    ).resolves.toEqual({ ok: true })
    expect(waits).toEqual([7])
    expect(calls).toBe(2)
  })

  it('does not retry 4xx answers that merely carry a Retry-After header', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return new Response('{}', { status: 404, headers: { 'Retry-After': '1' } })
    }
    const error = await rejection(fetchJson('https://source.test/lookup', { fetchFn }))
    expect(error.code).toBe('http')
    expect(error.status).toBe(404)
    expect(calls).toBe(1)
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta-seconds and HTTP-dates, rejecting garbage', () => {
    expect(parseRetryAfterMs('5')).toBe(5000)
    expect(parseRetryAfterMs(' 12 ')).toBe(12000)
    const now = (): number => Date.parse('2026-10-11T00:00:00Z')
    expect(parseRetryAfterMs('Sun, 11 Oct 2026 00:00:02 GMT', now)).toBe(2000)
    expect(parseRetryAfterMs('Sun, 11 Oct 2026 00:00:00 GMT', now)).toBe(0) // past → immediate
    expect(parseRetryAfterMs('soon', now)).toBeNull()
    expect(parseRetryAfterMs('', now)).toBeNull()
    expect(parseRetryAfterMs(null, now)).toBeNull()
  })
})

describe('fetchJson — interruptions during response-body reads', () => {
  it('rejects as aborted when cancelled while reading a successful response body', async () => {
    const controller = new AbortController()
    const { response, failJson } = controllableJson(200)
    const { fetchFn, called } = gatedFetch(response)
    const pending = fetchJson('https://source.test/data', {
      fetchFn,
      signal: controller.signal,
      retryDelayMs: 0,
    })
    await called // the response arrived; the body read is in flight
    controller.abort()
    failJson(new DOMException('The operation was aborted.', 'AbortError'))
    const error = await rejection(pending)
    expect(error.code).toBe('aborted') // not invalid-response
  })

  it('rejects as timeout when the attempt budget expires during a successful body read', async () => {
    vi.useFakeTimers()
    try {
      const { response, failJson } = controllableJson(200)
      const { fetchFn, called } = gatedFetch(response)
      const pending = fetchJson('https://source.test/data', {
        fetchFn,
        timeoutMs: 10,
        retryDelayMs: 0,
      })
      await called // the body read is in flight
      vi.advanceTimersByTime(10) // the attempt budget expires mid-read
      failJson(new DOMException('The operation was aborted.', 'AbortError'))
      const error = await rejection(pending)
      expect(error.code).toBe('timeout') // not invalid-response
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps aborted (not http) when cancelled while reading an error body', async () => {
    const controller = new AbortController()
    const { response, failJson } = controllableJson(404) // not retryable — the
    const { fetchFn, called } = gatedFetch(response) //  final error must be the interruption
    const pending = fetchJson('https://source.test/data', {
      fetchFn,
      signal: controller.signal,
      retryDelayMs: 0,
    })
    await called // the 404 arrived; its error body read is in flight
    controller.abort()
    failJson(new DOMException('The operation was aborted.', 'AbortError'))
    const error = await rejection(pending)
    expect(error.code).toBe('aborted') // never downgraded to http 404
    expect(error.status).toBeUndefined()
  })

  it('keeps invalid-response when a successful body read genuinely fails', async () => {
    const { response, failJson } = controllableJson(200)
    const { fetchFn, called } = gatedFetch(response)
    const pending = fetchJson('https://source.test/data', { fetchFn, retryDelayMs: 0 })
    await called
    failJson(new SyntaxError('Unexpected token < in JSON'))
    const error = await rejection(pending)
    expect(error.code).toBe('invalid-response')
  })

  it('keeps the HTTP status when the error body cannot be parsed', async () => {
    let calls = 0
    const fetchFn: FetchLike = async () => {
      calls += 1
      return new Response('<html>gateway</html>', { status: 404 })
    }
    const error = await rejection(fetchJson('https://source.test/x', { fetchFn }))
    expect(error.code).toBe('http')
    expect(error.status).toBe(404)
    expect(calls).toBe(1)
  })
})
