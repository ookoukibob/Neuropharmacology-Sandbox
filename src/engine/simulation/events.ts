/**
 * Dosing-event validation, ordering and infusion bookkeeping (phase 41).
 *
 * This module owns *when dosing changes* — never the model equations and
 * never the numerics. The scheduler is a pure state machine over time:
 *
 *   `options()`        total active infusion rate for the current system
 *   `applyGroup(t)`    apply every event scheduled at t, in the documented
 *                      order, returning one trace per event
 *
 * Ordering policy (ADR-24). Same-time events are applied in three phases:
 *
 *   1. `infusion-stop`   — infusions already running are stopped;
 *   2. `iv-bolus`        — instantaneous amount jumps;
 *   3. `infusion-start`  — new infusions begin.
 *
 * Within one phase, events are ordered by `eventId` (code-point comparison),
 * so the order is total, deterministic and independent of array position.
 *
 * An infusion is therefore valid only if its first start has an earlier,
 * distinct time and its stop is strictly later than that start; a stop/start
 * pair at the same instant is rejected as a zero-length interval rather than
 * silently reinterpreted. The same `infusionId` may be started again after a
 * stop (a repeated session), and bolus doses may repeat freely as long as
 * their `eventId`s are unique.
 */
import { STATE_INDEX, copyState, compareCodePoints, eventOrderKey, sumRates } from './units'
import type {
  DosingEvent,
  EventKind,
  EventTraceEntry,
  InfusionRatePoint,
  OdeState,
  SimulationError,
} from './types'

export interface ValidatedEventGroup {
  /** The shared time of the group (hours). */
  readonly time: number
  /** 1-based index among the distinct event times. */
  readonly groupIndex: number
  /** Events of the group, already in application order. */
  readonly events: readonly DosingEvent[]
}

export interface ValidatedSchedule {
  /** Distinct event times, ascending, each with its ordered event group. */
  readonly groups: readonly ValidatedEventGroup[]
  /** Canonical infusion rate per (start) event id, mg/h. */
  readonly rateByEventId: ReadonlyMap<string, number>
  /** Canonical bolus amount per event id, mg. */
  readonly amountByEventId: ReadonlyMap<string, number>
  /**
   * Infusions whose FIRST start lies at the simulation start time.
   *
   * A bolus applied by the orchestrator at t0 is part of the initial state,
   * so `A_in` must start at that amount too. Only a first start explains a
   * bolus at t0: any later session of the same infusion is a renewed supply.
   */
  readonly carriedInInfusionIds: ReadonlySet<string>
}

const KIND_LABEL: Readonly<Record<EventKind, string>> = {
  'iv-bolus': 'IV bolus',
  'infusion-start': 'infusion start',
  'infusion-stop': 'infusion stop',
}

/**
 * Validate and order a dosing schedule.
 *
 * `convertRate` / `convertAmount` turn a declared quantity into the canonical
 * unit (mg/h, mg) and report a typed error via the `error` callback instead of
 * returning a number; the orchestrator supplies the unit-aware versions.
 */
export interface ScheduleInputs {
  readonly startTime: number
  readonly endTime: number
  readonly events: readonly DosingEvent[]
  readonly convertRate: (eventId: string, declared: DosingEvent) => { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: SimulationError }
  readonly convertAmount: (eventId: string, declared: DosingEvent) => { readonly ok: true; readonly value: number } | { readonly ok: false; readonly error: SimulationError }
}

export type ScheduleValidation =
  | { readonly ok: true; readonly schedule: ValidatedSchedule }
  | { readonly ok: false; readonly errors: readonly SimulationError[] }

/** Validate every event on its own (identifiers, times, quantities). */
function validateEventBasics(
  event: DosingEvent,
  index: number,
  inputs: ScheduleInputs,
  errors: SimulationError[],
  seenEventIds: Map<string, DosingEvent>,
): void {
  const field = `events[${index}]`
  const kindLabel = KIND_LABEL[event.type]

  if (typeof event.eventId !== 'string' || event.eventId.trim() === '') {
    errors.push({
      code: 'MISSING_PARAMETER',
      stage: 'events',
      field: `${field}.eventId`,
      message: `Every dosing event needs a non-empty eventId (event at index ${index}).`,
    })
  } else {
    const previous = seenEventIds.get(event.eventId)
    if (previous !== undefined) {
      errors.push({
        code: 'INVALID_EVENT_SEQUENCE',
        stage: 'events',
        field: `${field}.eventId`,
        eventId: event.eventId,
        message: `Event id "${event.eventId}" is used more than once; identifiers must be unique across the scenario.`,
      })
    } else {
      seenEventIds.set(event.eventId, event)
    }
  }

  if (typeof event.time !== 'number' || !Number.isFinite(event.time)) {
    errors.push({
      code: 'NOT_A_NUMBER',
      stage: 'events',
      field: `${field}.time`,
      eventId: event.eventId,
      message: `The ${kindLabel} "${event.eventId}" needs a finite time (got ${String(event.time)}).`,
    })
    return
  }
  if (event.time < inputs.startTime || event.time > inputs.endTime) {
    errors.push({
      code: 'OUT_OF_RANGE',
      stage: 'events',
      field: `${field}.time`,
      eventId: event.eventId,
      message: `The ${kindLabel} "${event.eventId}" at ${event.time} h lies outside the simulation horizon [${inputs.startTime}, ${inputs.endTime}] h.`,
    })
  }

  if (event.type === 'iv-bolus') {
    const amount = event.amount
    if (amount === undefined || typeof amount !== 'object') {
      errors.push({
        code: 'MISSING_PARAMETER',
        stage: 'events',
        field: `${field}.amount`,
        eventId: event.eventId,
        message: `The IV bolus "${event.eventId}" needs an amount with a value and a unit.`,
      })
      return
    }
    if (typeof amount.value !== 'number' || !Number.isFinite(amount.value)) {
      errors.push({
        code: 'NOT_A_NUMBER',
        stage: 'events',
        field: `${field}.amount.value`,
        eventId: event.eventId,
        message: `The IV bolus amount must be a finite number (got ${String(amount.value)}).`,
      })
    } else if (amount.value < 0) {
      errors.push({
        code: 'NEGATIVE_VALUE',
        stage: 'events',
        field: `${field}.amount.value`,
        eventId: event.eventId,
        message: `The IV bolus amount must be 0 or greater (got ${amount.value}).`,
      })
    }
    const converted = inputs.convertAmount(event.eventId, event)
    if (!converted.ok) errors.push({ ...converted.error, eventId: event.eventId })
    return
  }

  if (typeof event.infusionId !== 'string' || event.infusionId.trim() === '') {
    errors.push({
      code: 'MISSING_PARAMETER',
      stage: 'events',
      field: `${field}.infusionId`,
      eventId: event.eventId,
      message: `The ${kindLabel} "${event.eventId}" needs a non-empty infusionId.`,
    })
  }

  if (event.type === 'infusion-start') {
    const rate = event.rate
    if (rate === undefined || typeof rate !== 'object') {
      errors.push({
        code: 'MISSING_PARAMETER',
        stage: 'events',
        field: `${field}.rate`,
        eventId: event.eventId,
        message: `The infusion start "${event.eventId}" needs a rate with a value and a unit.`,
      })
      return
    }
    if (typeof rate.value !== 'number' || !Number.isFinite(rate.value)) {
      errors.push({
        code: 'NOT_A_NUMBER',
        stage: 'events',
        field: `${field}.rate.value`,
        eventId: event.eventId,
        message: `The infusion rate must be a finite number (got ${String(rate.value)}).`,
      })
    } else if (rate.value < 0) {
      errors.push({
        code: 'NEGATIVE_VALUE',
        stage: 'events',
        field: `${field}.rate.value`,
        eventId: event.eventId,
        message: `The infusion rate must be 0 or greater (got ${rate.value}). A negative rate is not a withdrawal.`,
      })
    }
    const converted = inputs.convertRate(event.eventId, event)
    if (!converted.ok) errors.push({ ...converted.error, eventId: event.eventId })
  }
}

/**
 * Pair starts and stops per `infusionId`, then check each session.
 *
 * A session list is built in *application* order (time, then stop-before-start
 * inside a time group), which is exactly the order the scheduler will see.
 */
function validateInfusionSessions(
  events: readonly DosingEvent[],
  errors: SimulationError[],
): void {
  const ordered = orderEvents(events.filter((e) => e.type !== 'iv-bolus'))
  const sessions = new Map<string, { readonly event: DosingEvent; readonly time: number }[]>()
  for (const event of ordered) {
    if (typeof event.time !== 'number' || !Number.isFinite(event.time)) continue
    const list = sessions.get(event.infusionId) ?? []
    list.push({ event, time: event.time })
    sessions.set(event.infusionId, list)
  }

  for (const [infusionId, list] of sessions) {
    let open: { readonly eventId: string; readonly time: number } | undefined
    for (const { event, time } of list) {
      if (event.type === 'infusion-start') {
        if (open !== undefined) {
          errors.push({
            code: 'INVALID_EVENT_SEQUENCE',
            stage: 'events',
            field: 'infusionId',
            eventId: event.eventId,
            message: `Infusion "${infusionId}" is started again by "${event.eventId}" while the session opened by "${open.eventId}" at ${open.time} h is still running; stop it first.`,
          })
          continue
        }
        open = { eventId: event.eventId, time }
      } else {
        if (open === undefined) {
          errors.push({
            code: 'INVALID_EVENT_SEQUENCE',
            stage: 'events',
            field: 'infusionId',
            eventId: event.eventId,
            message: `The infusion stop "${event.eventId}" has no preceding start for infusion "${infusionId}".`,
          })
          continue
        }
        if (!(time > open.time)) {
          errors.push({
            code: 'INVALID_EVENT_SEQUENCE',
            stage: 'events',
            field: 'infusionId',
            eventId: event.eventId,
            message: `Infusion "${infusionId}" would have zero duration: its stop "${event.eventId}" is at the same time as its start "${open.eventId}" (${time} h).`,
          })
        }
        open = undefined
      }
    }
    if (open !== undefined) {
      errors.push({
        code: 'INVALID_EVENT_SEQUENCE',
        stage: 'events',
        field: 'infusionId',
        eventId: open.eventId,
        message: `Infusion "${infusionId}" is started by "${open.eventId}" at ${open.time} h but never stopped; an open infusion ends only at a declared stop event.`,
      })
    }
  }
}

/**
 * Total order of events: time, then kind phase (stop → bolus → start), then
 * event id. A comparison function, so no reliance on sort stability.
 */
export function orderEvents<T extends { readonly type: EventKind; readonly eventId: string; readonly time: number }>(
  events: readonly T[],
): readonly T[] {
  return events.slice().sort((a, b) => {
    if (a.time !== b.time) return a.time < b.time ? -1 : 1
    const kindA = eventOrderKey(a)
    const kindB = eventOrderKey(b)
    if (kindA !== kindB) return kindA - kindB
    return compareCodePoints(a.eventId, b.eventId)
  })
}

export function validateSchedule(inputs: ScheduleInputs): ScheduleValidation {
  const errors: SimulationError[] = []
  const seenEventIds = new Map<string, DosingEvent>()
  const rateByEventId = new Map<string, number>()
  const amountByEventId = new Map<string, number>()

  inputs.events.forEach((event, index) => {
    validateEventBasics(event, index, inputs, errors, seenEventIds)
    if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return
    if (event.type === 'infusion-start') {
      const converted = inputs.convertRate(event.eventId, event)
      if (converted.ok) rateByEventId.set(event.eventId, converted.value)
    } else if (event.type === 'iv-bolus') {
      const converted = inputs.convertAmount(event.eventId, event)
      if (converted.ok) amountByEventId.set(event.eventId, converted.value)
    }
  })

  // Sessions are checked even when a quantity error exists: every error is
  // reported at once. Identifier uniqueness was checked above.
  validateInfusionSessions(inputs.events, errors)

  if (errors.length > 0) return { ok: false, errors }

  const firstStart = new Map<string, number>()
  for (const event of inputs.events) {
    if (event.type !== 'infusion-start' || !Number.isFinite(event.time)) continue
    const existing = firstStart.get(event.infusionId)
    if (existing === undefined || event.time < existing) firstStart.set(event.infusionId, event.time)
  }
  const carriedInInfusionIds = new Set(
    [...firstStart.entries()].filter(([, time]) => time === inputs.startTime).map(([id]) => id),
  )

  const ordered = orderEvents(inputs.events)
  const groups: ValidatedEventGroup[] = []
  for (const event of ordered) {
    const last = groups[groups.length - 1]
    if (last !== undefined && last.time === event.time) {
      groups[groups.length - 1] = { time: last.time, groupIndex: last.groupIndex, events: [...last.events, event] }
    } else {
      groups.push({ time: event.time, groupIndex: groups.length + 1, events: [event] })
    }
  }
  return { ok: true, schedule: { groups, rateByEventId, amountByEventId, carriedInInfusionIds } }
}

// ---------------------------------------------------------------------------
// Runtime scheduler
// ---------------------------------------------------------------------------

/** Mutable model inputs the scheduler changes as events are applied. */
export interface DosingOptions {
  /** Total active infusion rate R_in (mg/h). */
  readonly infusionRate: number
}

/**
 * Deterministic event application over time.
 *
 * The scheduler keeps only two pieces of state — the set of running infusions
 * and the rate of each — and derives R_in from them, so "sum of active rates"
 * is the single definition used everywhere.
 */
export class EventScheduler {
  private readonly schedule: ValidatedSchedule
  private readonly running = new Map<string, number>()
  private readonly groupsApplied = new Set<number>()
  private groupCursor = 0

  constructor(schedule: ValidatedSchedule) {
    this.schedule = schedule
  }

  get totalRate(): number {
    return sumRates([...this.running.values()])
  }

  get activeInfusionIds(): readonly string[] {
    return [...this.running.keys()].sort(compareCodePoints)
  }

  get options(): DosingOptions {
    return { infusionRate: this.totalRate }
  }

  /** Time of the next scheduled event group, or undefined when none is left. */
  nextGroupTime(): number | undefined {
    return this.schedule.groups[this.groupCursor]?.time
  }

  /** Next group strictly after `time`, or undefined. */
  groupAfter(time: number): ValidatedEventGroup | undefined {
    for (const group of this.schedule.groups) {
      if (group.time > time) return group
    }
    return undefined
  }

  /**
   * Apply the group scheduled at exactly `time`. Applying the same group
   * twice is an implementation error and throws: the orchestrator drives this
   * from the group list, so a double application could only be a bug.
   */
  applyGroup(
    time: number,
    group: ValidatedEventGroup,
    state: OdeState,
  ): { readonly trace: readonly EventTraceEntry[]; readonly state: OdeState } {
    if (this.groupsApplied.has(group.groupIndex)) {
      throw new Error(`simulation: event group ${group.groupIndex} was applied twice`)
    }
    this.groupsApplied.add(group.groupIndex)
    this.groupCursor = Math.max(this.groupCursor, group.groupIndex)

    let current = state.slice()
    const trace: EventTraceEntry[] = []
    group.events.forEach((event, indexInGroup) => {
      const before = copyState(current)

      let canonicalValue: number | undefined
      let canonicalUnit: 'mg' | 'mg/h' | undefined

      switch (event.type) {
        case 'iv-bolus': {
          canonicalValue = this.schedule.amountByEventId.get(event.eventId)
          canonicalUnit = 'mg'
          const amount = canonicalValue ?? Number.NaN
          // One convention for every bolus, at t0 or later (ADR-25): the
          // central amount jumps by D and the cumulative-input accounting
          // state rises by the same D. A_in therefore counts each dose
          // exactly once, and the reference physical amount never contains a
          // dose.
          const next = current.slice()
          next[STATE_INDEX.centralAmount] = (next[STATE_INDEX.centralAmount] ?? 0) + amount
          next[STATE_INDEX.cumulativeInput] = (next[STATE_INDEX.cumulativeInput] ?? 0) + amount
          current = next
          break
        }
        case 'infusion-start': {
          canonicalValue = this.schedule.rateByEventId.get(event.eventId)
          canonicalUnit = 'mg/h'
          if (canonicalValue === undefined) break
          this.running.set(event.infusionId, canonicalValue)
          break
        }
        case 'infusion-stop': {
          this.running.delete(event.infusionId)
          break
        }
      }

      const declared =
        event.type === 'iv-bolus'
          ? event.amount
          : event.type === 'infusion-start'
            ? event.rate
            : undefined

      const entry: EventTraceEntry = {
        eventId: event.eventId,
        type: event.type,
        time,
        groupIndex: group.groupIndex,
        orderInGroup: indexInGroup + 1,
        ...(declared === undefined ? {} : { declaredValue: declared }),
        ...(canonicalValue === undefined || canonicalUnit === undefined
          ? {}
          : { canonicalValue, canonicalUnit }),
        ...(event.type === 'iv-bolus' ? {} : { infusionId: event.infusionId }),
        before,
        after: copyState(current),
        // The active set and R_in *after* this event: the dosing input the
        // next integration segment will use. The pre-group values are on the
        // pre-event sample and its infusion-rate point.
        activeInfusionIds: this.activeInfusionIds,
        totalInfusionRate: this.totalRate,
      }
      trace.push(entry)
    })

    return { trace, state: current }
  }

  /**
   * Snapshot of the infusion step at `time` on one side of the event group.
   * The caller supplies the pre-event rate it observed; the post-event rate is
   * always the scheduler's current total, so the two sides can never disagree.
   */
  ratePoint(
    time: number,
    side: 'pre-event' | 'post-event',
    preEvent: { readonly rate: number; readonly activeInfusionIds: readonly string[] },
  ): InfusionRatePoint {
    if (side === 'post-event') {
      return { time, side, totalRate: this.totalRate, activeInfusionIds: this.activeInfusionIds }
    }
    return { time, side, totalRate: preEvent.rate, activeInfusionIds: preEvent.activeInfusionIds }
  }
}

/** Validate and build a scheduler in one call. */
export function createScheduler(inputs: ScheduleInputs):
  | { readonly ok: true; readonly scheduler: EventScheduler; readonly schedule: ValidatedSchedule }
  | { readonly ok: false; readonly errors: readonly SimulationError[] } {
  const validation = validateSchedule(inputs)
  if (!validation.ok) return validation
  return {
    ok: true,
    scheduler: new EventScheduler(validation.schedule),
    schedule: validation.schedule,
  }
}