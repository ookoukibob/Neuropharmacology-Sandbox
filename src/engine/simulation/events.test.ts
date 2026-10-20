import { describe, expect, it } from 'vitest'
import { createScheduler, orderEvents, validateSchedule } from './events'
import type { DosingEvent, OdeState, SimulationError } from './types'

/**
 * The scheduler is tested without the PK model: its inputs are a synthetic
 * state vector and a synthetic unit layer whose factors are 1 (mg, mg/h) or
 * simple multiples, so every expectation below is arithmetic, not PK.
 */

const ok = (value: number): { readonly ok: true; readonly value: number } => ({ ok: true, value })
const bad = (message: string): { readonly ok: false; readonly error: SimulationError } => ({
  ok: false,
  error: { code: 'INVALID_EVENT_SEQUENCE', stage: 'events', message },
})

const inputs = (events: readonly DosingEvent[]) => ({
  startTime: 0,
  endTime: 24,
  events,
  convertRate: (id: string, event: DosingEvent) =>
    event.type === 'infusion-start' ? ok(event.rate.value) : bad(`${id} is not an infusion start`),
  convertAmount: (id: string, event: DosingEvent) =>
    event.type === 'iv-bolus' ? ok(event.amount.value) : bad(`${id} is not a bolus`),
})

const bolus = (eventId: string, time: number, amount: number): DosingEvent => ({
  type: 'iv-bolus',
  eventId,
  time,
  amount: { value: amount, unit: 'mg' },
})
const start = (eventId: string, infusionId: string, time: number, rate: number): DosingEvent => ({
  type: 'infusion-start',
  eventId,
  infusionId,
  time,
  rate: { value: rate, unit: 'mg/h' },
})
const stop = (eventId: string, infusionId: string, time: number): DosingEvent => ({
  type: 'infusion-stop',
  eventId,
  infusionId,
  time,
})

const errorsOf = (events: readonly DosingEvent[]): readonly SimulationError[] => {
  const result = validateSchedule(inputs(events))
  return result.ok ? [] : result.errors
}

const scheduleOf = (events: readonly DosingEvent[]) => {
  const result = createScheduler(inputs(events))
  if (!result.ok) throw new Error('schedule rejected: ' + JSON.stringify(result.errors))
  return result
}

describe('validateSchedule — structure and identifiers', () => {
  it('accepts an empty schedule', () => {
    const result = validateSchedule(inputs([]))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.schedule.groups).toHaveLength(0)
  })

  it('rejects a missing or empty event id', () => {
    const missing = errorsOf([{ type: 'iv-bolus', eventId: '', time: 1, amount: { value: 1, unit: 'mg' } }])
    expect(missing[0]?.code).toBe('MISSING_PARAMETER')
    expect(missing[0]?.field).toBe('events[0].eventId')
  })

  it('rejects duplicate event ids even when everything else differs', () => {
    const errors = errorsOf([bolus('d1', 1, 10), bolus('d1', 2, 20)])
    expect(errors.map((e) => e.code)).toContain('INVALID_EVENT_SEQUENCE')
    expect(errors[0]?.eventId).toBe('d1')
  })

  it('rejects non-finite, out-of-horizon and negative quantities', () => {
    expect(errorsOf([{ ...bolus('d1', Number.NaN, 1) }])[0]?.code).toBe('NOT_A_NUMBER')
    expect(errorsOf([bolus('d1', 30, 1)])[0]?.code).toBe('OUT_OF_RANGE')
    expect(errorsOf([bolus('d1', -1, 1)])[0]?.code).toBe('OUT_OF_RANGE')
    expect(errorsOf([bolus('d1', 1, -5)])[0]?.code).toBe('NEGATIVE_VALUE')
    expect(errorsOf([start('s1', 'A', 0, -1)])[0]?.code).toBe('NEGATIVE_VALUE')
    expect(errorsOf([start('s1', 'A', 0, Number.POSITIVE_INFINITY)])[0]?.code).toBe('NOT_A_NUMBER')
  })

  it('requires a non-empty infusionId', () => {
    const errors = errorsOf([start('s1', '   ', 0, 1)])
    expect(errors[0]?.code).toBe('MISSING_PARAMETER')
    expect(errors[0]?.field).toBe('events[0].infusionId')
  })
})

describe('validateSchedule — infusion sessions', () => {
  it('accepts a single start/stop pair and a repeated session of the same infusion', () => {
    expect(
      errorsOf([start('s1', 'A', 0, 10), stop('s2', 'A', 2), start('s3', 'A', 4, 5), stop('s4', 'A', 6)]),
    ).toHaveLength(0)
  })

  it('rejects a stop with no preceding start', () => {
    const errors = errorsOf([stop('e1', 'ghost', 2)])
    expect(errors[0]?.code).toBe('INVALID_EVENT_SEQUENCE')
    expect(errors[0]?.eventId).toBe('e1')
    expect(errors[0]?.message).toContain('no preceding start')
  })

  it('rejects an unstopped infusion (an open infusion has no implicit end)', () => {
    const errors = errorsOf([start('s1', 'A', 0, 10)])
    expect(errors[0]?.code).toBe('INVALID_EVENT_SEQUENCE')
    expect(errors[0]?.message).toContain('never stopped')
  })

  it('rejects a second start while the session is open', () => {
    const errors = errorsOf([start('s1', 'A', 0, 10), start('s2', 'A', 1, 5), stop('s3', 'A', 2)])
    expect(errors.some((e) => e.message.includes('started again'))).toBe(true)
  })

  it('rejects a repeated stop', () => {
    const errors = errorsOf([start('s1', 'A', 0, 10), stop('s2', 'A', 1), stop('s3', 'A', 2)])
    expect(errors.some((e) => e.eventId === 's3')).toBe(true)
  })

  it('rejects a zero-duration pair (start and stop at the same instant)', () => {
    // Inside one time group stops are applied before starts, so a start and
    // its stop at the same instant can never form a positive-length interval:
    // the stop is evaluated first and has no session to close.
    const errors = errorsOf([start('s1', 'A', 3, 10), stop('s2', 'A', 3)])
    expect(errors[0]?.code).toBe('INVALID_EVENT_SEQUENCE')
    expect(errors[0]?.eventId).toBe('s2')
    expect(errors[0]?.message).toContain('no preceding start')
  })

  it('rejects a stop that closes a session opened in the same group', () => {
    const errors = errorsOf([start('s1', 'A', 3, 10), stop('s2', 'A', 3), start('s3', 'A', 3, 1)])
    expect(errors.some((e) => e.code === 'INVALID_EVENT_SEQUENCE')).toBe(true)
  })

  it('reports every independent problem at once', () => {
    const errors = errorsOf([
      bolus('d1', 1, -1),
      stop('e1', 'ghost', 2),
      start('s1', 'B', 3, 1),
      stop('s2', 'B', 4),
    ])
    // A negative bolus and a stop without a start, from different events.
    expect(errors.map((e) => e.code)).toEqual(['NEGATIVE_VALUE', 'INVALID_EVENT_SEQUENCE'])
    expect(errors.map((e) => e.eventId)).toEqual(['d1', 'e1'])
  })
})

describe('orderEvents — the documented total order', () => {
  it('orders by time, then stop → bolus → start, then event id', () => {
    const events = [
      start('s1', 'A', 5, 1),
      bolus('b2', 5, 1),
      stop('t9', 'OLD', 5),
      bolus('b1', 5, 1),
      start('s0', 'B', 5, 1),
      bolus('early', 1, 1),
    ]
    const ordered = orderEvents(events)
    expect(ordered.map((e) => e.eventId)).toEqual(['early', 't9', 'b1', 'b2', 's0', 's1'])
  })

  it('compares ids by code point, not by locale or array position', () => {
    const ordered = orderEvents([bolus('b', 1, 1), bolus('B', 1, 1), bolus('a', 1, 1)])
    // 'B' (0x42) < 'a' (0x61) < 'b' (0x62) by code point.
    expect(ordered.map((e) => e.eventId)).toEqual(['B', 'a', 'b'])
  })

  it('is independent of the input array order', () => {
    const events = [start('s1', 'A', 4, 1), bolus('b', 2, 1), stop('t', 'A', 8), bolus('a', 4, 1)]
    const a = orderEvents(events).map((e) => e.eventId)
    const b = orderEvents(events.slice().reverse()).map((e) => e.eventId)
    const c = orderEvents([events[2]!, events[0]!, events[3]!, events[1]!]).map((e) => e.eventId)
    expect(a).toEqual(b)
    expect(a).toEqual(c)
  })
})

describe('EventScheduler — state jumps and infusion bookkeeping', () => {
  const state = (central: number): OdeState => [central, 0, 0, 0]

  it('applies a bolus as an instantaneous jump and records before/after', () => {
    const { scheduler, schedule } = scheduleOf([bolus('d1', 2, 50)])
    const group = schedule.groups[0]!
    const applied = scheduler.applyGroup(2, group, state(10))
    expect(applied.state).toEqual([60, 0, 0, 50])
    const entry = applied.trace[0]!
    expect(entry.type).toBe('iv-bolus')
    expect(entry.time).toBe(2)
    expect(entry.before).toEqual([10, 0, 0, 0])
    expect(entry.after).toEqual([60, 0, 0, 50])
    expect(entry.canonicalValue).toBe(50)
    expect(entry.canonicalUnit).toBe('mg')
  })

  it('sums overlapping infusion rates and removes them at their stops', () => {
    const { scheduler, schedule } = scheduleOf([
      start('s1', 'A', 0, 10),
      start('s2', 'B', 1, 5),
      stop('t1', 'A', 3),
      stop('t2', 'B', 4),
    ])
    const byTime = new Map(schedule.groups.map((g) => [g.time, g]))
    expect(scheduler.totalRate).toBe(0)
    scheduler.applyGroup(0, byTime.get(0)!, state(0))
    expect(scheduler.totalRate).toBe(10)
    scheduler.applyGroup(1, byTime.get(1)!, state(0))
    expect(scheduler.totalRate).toBe(15)
    expect(scheduler.activeInfusionIds).toEqual(['A', 'B'])
    scheduler.applyGroup(3, byTime.get(3)!, state(0))
    expect(scheduler.totalRate).toBe(5)
    expect(scheduler.activeInfusionIds).toEqual(['B'])
    scheduler.applyGroup(4, byTime.get(4)!, state(0))
    expect(scheduler.totalRate).toBe(0)
    expect(scheduler.options.infusionRate).toBe(0)
  })

  it('applies same-time groups in the documented order: stop, bolus, start', () => {
    const { scheduler, schedule } = scheduleOf([
      start('s1', 'A', 0, 10),
      stop('t1', 'A', 5), // closes A's session…
      start('s2', 'A', 5, 4), // …and re-opens it at a new rate the same instant
      start('s3', 'B', 5, 1),
      stop('t2', 'B', 8),
      stop('t3', 'A', 9),
      bolus('b1', 5, 7),
    ])
    const group = schedule.groups.find((g) => g.time === 5)!
    expect(group.events.map((e) => e.type)).toEqual([
      'infusion-stop',
      'iv-bolus',
      'infusion-start',
      'infusion-start',
    ])
    scheduler.applyGroup(0, schedule.groups[0]!, state(0))
    expect(scheduler.totalRate).toBe(10)
    const applied = scheduler.applyGroup(5, group, [0, 0, 0, 0])
    // Starts between the two events are ordered by id: 's2' < 's3'.
    expect(applied.trace.map((e) => e.eventId)).toEqual(['t1', 'b1', 's2', 's3'])
    expect(applied.trace.map((e) => e.orderInGroup)).toEqual([1, 2, 3, 4])
    expect(applied.state[0]).toBe(7)
    expect(scheduler.totalRate).toBe(5) // 4 (A) + 1 (B)
    // Each trace step records the dosing input in force after it was applied.
    expect(applied.trace.map((e) => e.totalInfusionRate)).toEqual([0, 0, 4, 5])
  })

  it('never applies the same group twice', () => {
    const { scheduler, schedule } = scheduleOf([bolus('d1', 2, 10)])
    scheduler.applyGroup(2, schedule.groups[0]!, state(0))
    expect(() => scheduler.applyGroup(2, schedule.groups[0]!, state(0))).toThrow(/applied twice/)
  })

  it('does not mutate the caller-owned state', () => {
    const { scheduler, schedule } = scheduleOf([bolus('d1', 2, 10)])
    const initial = Object.freeze([1, 2, 3, 4]) as OdeState
    scheduler.applyGroup(2, schedule.groups[0]!, initial)
    expect(initial).toEqual([1, 2, 3, 4])
  })

  it('finds the next group only strictly after a time', () => {
    const { scheduler, schedule } = scheduleOf([bolus('d1', 1, 10), bolus('d2', 3, 10)])
    expect(scheduler.groupAfter(0)?.time).toBe(1)
    expect(scheduler.groupAfter(1)?.time).toBe(3)
    expect(scheduler.groupAfter(3)).toBeUndefined()
    expect(schedule.groups.map((g) => g.groupIndex)).toEqual([1, 2])
  })

  it('marks infusions whose first start is at the simulation start', () => {
    const { schedule } = scheduleOf([
      start('s1', 'A', 0, 1),
      stop('t1', 'A', 2),
      start('s2', 'A', 4, 1),
      stop('t2', 'A', 6),
      start('s3', 'B', 4, 1),
      stop('t3', 'B', 6),
    ])
    expect([...schedule.carriedInInfusionIds]).toEqual(['A'])
    expect(schedule.rateByEventId.get('s2')).toBe(1)
    expect([...schedule.amountByEventId.keys()]).toEqual([])
  })

  it('keeps the pre/post rate snapshots honest across a group', () => {
    const { scheduler, schedule } = scheduleOf([start('s1', 'A', 0, 3), stop('t1', 'A', 6)])
    const base = { rate: 0, activeInfusionIds: [] as readonly string[] }
    scheduler.applyGroup(0, schedule.groups[0]!, [0, 0, 0, 0])
    const pre = scheduler.ratePoint(0, 'pre-event', base)
    const post = scheduler.ratePoint(0, 'post-event', base)
    expect(pre.totalRate).toBe(0)
    expect(post.totalRate).toBe(3)
    expect(post.activeInfusionIds).toEqual(['A'])
  })
})
