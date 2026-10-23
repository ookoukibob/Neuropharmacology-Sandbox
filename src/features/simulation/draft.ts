/**
 * Scenario form draft and its compilation into the engine contract (phase 43).
 *
 * Three representations, deliberately separate:
 *
 *   SimulationDraft        exactly what the form holds: every numeric field is
 *                          a STRING, a blank field stays blank (never 0), and
 *                          dosing events are user-facing rows (a bolus, or one
 *                          infusion session) keyed by a stable integer.
 *   SimulationScenario     the Phase 41 engine contract built by
 *                          `compileScenario` — or nothing, with typed draft
 *                          errors when the text cannot be parsed.
 *   SimulationReport       what `simulate()` returns for that scenario,
 *                          including every scientific validation error.
 *
 * The draft is never mutated: `compileScenario` reads it, returns new
 * objects, and leaves its input scenario and every previous result untouched.
 *
 * Draft-level errors are limited to what parsing can decide (a required field
 * is blank, a number is unparseable, the output grid is unbuildable). Anything
 * scientific — units, positivity, event sequencing, horizon boundaries — is
 * left to the engine, whose typed errors are the authority.
 */
import type { DosingEvent, SimulationError, SimulationScenario, SolverOptions } from '@/engine/simulation/types'
import type { EffectSiteInput } from '@/engine/simulation/effect-site'
import { buildOutputGrid, parseNumericText, type OutputGridResult } from './outputGrid'

// ---------------------------------------------------------------------------
// Units offered by the editor
// ---------------------------------------------------------------------------

/**
 * Unit choices come from the engine's catalog (the same objects its
 * conversion functions use), filtered by physical dimension — never a
 * hand-maintained list that could drift from what the engine accepts.
 */
export type EditorUnitDimension =
  | 'volume'
  | 'clearance'
  | 'mass'
  | 'mass-flow-rate'
  /**
   * Concentration units for Kd (phase 46). The catalog exposes both mass and
   * molar concentrations; Kd's dimension compatibility with the model
   * concentration is enforced by `resolveEffectSite`, not by this list.
   */
  | 'concentration'

// ---------------------------------------------------------------------------
// Draft shapes
// ---------------------------------------------------------------------------

export interface QuantityDraft {
  readonly value: string
  readonly unit: string
}

export interface BolusRow {
  readonly kind: 'bolus'
  /** Stable row key; survives edits, edits other rows, and reordering. */
  readonly key: number
  readonly time: string
  readonly amount: QuantityDraft
  /**
   * Optional repeat: `repeatCount` is the total number of doses (blank/1 = a
   * single dose), `repeatInterval` is the hours between successive doses.
   * Both are draft strings; blank means "no repeat". Saved records from
   * before phase 49 omit them entirely.
   */
  readonly repeatInterval?: string
  readonly repeatCount?: string
}

export interface InfusionRow {
  readonly kind: 'infusion'
  readonly key: number
  readonly startTime: string
  readonly stopTime: string
  readonly rate: QuantityDraft
  /**
   * Optional repeat, as for `BolusRow`. Session k spans
   * [start + (k−1)·interval, stop + (k−1)·interval]; the duration is constant
   * and the interval is measured between successive starts.
   */
  readonly repeatInterval?: string
  readonly repeatCount?: string
}

export type EventRow = BolusRow | InfusionRow

/**
 * A partial update to one event row, without its `kind` or `key`. Expressed as
 * an explicit union (rather than `Omit` over the `EventRow` union, which
 * collapses to the shared keys only) so every editable field is addressable.
 */
export type EventRowPatch =
  | Partial<Omit<BolusRow, 'kind' | 'key'>>
  | Partial<Omit<InfusionRow, 'kind' | 'key'>>

export interface SolverDraft {
  readonly absoluteTolerance: string
  readonly relativeTolerance: string
  readonly initialStep: string
  readonly minStep: string
  readonly maxStep: string
  readonly maxSteps: string
}

export interface SimulationDraft {
  readonly startTime: string
  readonly endTime: string
  readonly outputInterval: string
  readonly centralVolume: QuantityDraft
  readonly peripheralVolume: QuantityDraft
  readonly clearance: QuantityDraft
  readonly intercompartmentalClearance: QuantityDraft
  /** Initial amounts are plain numbers in canonical mg (InitialState). */
  readonly initialCentralAmount: string
  readonly initialPeripheralAmount: string
  readonly events: readonly EventRow[]
  readonly solver: SolverDraft
  /**
   * Opt-in effect-site / receptor-occupancy analysis (phase 46). Every text
   * field stays a STRING so blank or half-typed values remain editable and
   * savable — the draft is never forced into a runnable configuration.
   * Absent (legacy drafts) means effect-site analysis is disabled.
   */
  readonly effectSite?: EffectSiteDraft
}

/**
 * Editable effect-site section. `enabled` is a plain boolean; every numeric
 * input is draft text and no value is defaulted.
 */
export interface EffectSiteDraft {
  readonly enabled: boolean
  /** Unbound fraction fu (dimensionless). */
  readonly unboundFraction: string
  /** Equilibration rate ke0 in the canonical time base (h⁻¹). */
  readonly ke0: string
  /** Kd value with its declared concentration unit. */
  readonly kd: QuantityDraft
  /** Molecular weight (g/mol) — only needed when Kd is molar. */
  readonly molecularWeight: string
  /** Provenance of the molecular weight, required with a molar Kd. */
  readonly molecularWeightProvenance: string
}

/** A fresh effect-site section: disabled, with no invented values. */
export function emptyEffectSiteDraft(): EffectSiteDraft {
  return {
    enabled: false,
    unboundFraction: '',
    ke0: '',
    kd: { value: '', unit: 'mg/L' },
    molecularWeight: '',
    molecularWeightProvenance: '',
  }
}

/**
 * Fresh blank scenario for the editor. Scientific and time-horizon inputs stay
 * empty until the user supplies them; unit choices and solver configuration
 * remain technical editor defaults rather than a pre-filled drug scenario.
 */
export function emptyDraft(): SimulationDraft {
  return {
    startTime: '',
    endTime: '',
    outputInterval: '',
    centralVolume: { value: '', unit: 'L' },
    peripheralVolume: { value: '', unit: 'L' },
    clearance: { value: '', unit: 'L/h' },
    intercompartmentalClearance: { value: '', unit: 'L/h' },
    initialCentralAmount: '',
    initialPeripheralAmount: '',
    events: [],
    solver: {
      absoluteTolerance: '1e-10',
      relativeTolerance: '1e-10',
      initialStep: '0.01',
      minStep: '1e-12',
      maxStep: '0.25',
      maxSteps: '200000',
    },
    effectSite: emptyEffectSiteDraft(),
  }
}

// ---------------------------------------------------------------------------
// Draft errors
// ---------------------------------------------------------------------------

/**
 * Draft errors identify a field by path. Static paths reuse the shared
 * identifiers from `parameterFields` (`SimulationFieldId`), so a control and
 * its error can never disagree about which field they mean; dosing rows are
 * dynamic (`events.<key>.<part>`) because row keys are created as the user
 * adds rows.
 */
export interface DraftError {
  readonly code: 'REQUIRED' | 'NOT_A_NUMBER' | 'OUT_OF_RANGE'
  /**
   * Dotted field path, matching the control's data-field-path.
   *
   * The error carries an IDENTIFIER, never a label: turning it into readable
   * text (notation symbol included) is the presentation layer's job, via
   * `fieldSubject` / `<ParameterLabel>`. This keeps validation free of JSX and
   * leaves exactly one place where a parameter's name is written down.
   */
  readonly field: string
  /**
   * One sentence about the problem, with no parameter name in it: the summary
   * already renders the label, so repeating it here would read
   * "Central volume V_c: Central volume V_c is required."
   */
  readonly message: string
}

/** Errors for fields that could not be parsed (draft level). */
export type DraftValidation =
  | { readonly ok: true; readonly scenario: SimulationScenario }
  | { readonly ok: false; readonly errors: readonly DraftError[] }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const stringify = (value: number): string => {
  if (!Number.isFinite(value)) return ''
  return String(value)
}

/** Deterministic id helpers built from the row key (no randomness in render). */
export const bolusEventId = (key: number): string => `bolus-${key}`
export const infusionIdOf = (key: number): string => `infusion-${key}`
export const infusionStartEventId = (key: number): string => `infusion-${key}-start`
export const infusionStopEventId = (key: number): string => `infusion-${key}-stop`

/** Next free row key: pure function of the rows (StrictMode-safe). */
export function nextRowKey(rows: readonly EventRow[]): number {
  return rows.reduce((max, row) => Math.max(max, row.key), 0) + 1
}

/** A new bolus row with blank values: clicking "Add" never invents a dose. */
export function newBolusRow(rows: readonly EventRow[]): BolusRow {
  return { kind: 'bolus', key: nextRowKey(rows), time: '', amount: { value: '', unit: 'mg' }, repeatInterval: '', repeatCount: '' }
}

/** A new infusion row with blank times and rate. */
export function newInfusionRow(rows: readonly EventRow[]): InfusionRow {
  return {
    kind: 'infusion',
    key: nextRowKey(rows),
    startTime: '',
    stopTime: '',
    rate: { value: '', unit: 'mg/h' },
    repeatInterval: '',
    repeatCount: '',
  }
}

// ---------------------------------------------------------------------------
// Demo ↔ draft
// ---------------------------------------------------------------------------

/**
 * Derive an editable draft from a supplied scenario. Paired engine events
 * are folded back into one infusion session row, preserving one infusion
 * session in the editor while retaining both engine boundary events.
 */
export function draftFromScenario(scenario: SimulationScenario): SimulationDraft {
  const rows: EventRow[] = []
  const infusions = new Map<string, { start: number; stop?: number; rate: { value: number; unit: string } }>()
  let key = 0
  for (const event of scenario.events) {
    if (event.type === 'iv-bolus') {
      key += 1
      rows.push({
        kind: 'bolus',
        key,
        time: stringify(event.time),
        amount: { value: stringify(event.amount.value), unit: event.amount.unit },
        repeatInterval: '',
        repeatCount: '',
      })
    } else if (event.type === 'infusion-start') {
      infusions.set(event.infusionId, { start: event.time, rate: { value: event.rate.value, unit: event.rate.unit } })
    } else {
      const session = infusions.get(event.infusionId)
      if (session !== undefined) session.stop = event.time
    }
  }
  for (const session of infusions.values()) {
    key += 1
    rows.push({
      kind: 'infusion',
      key,
      startTime: stringify(session.start),
      stopTime: session.stop === undefined ? '' : stringify(session.stop),
      rate: { value: stringify(session.rate.value), unit: session.rate.unit },
      repeatInterval: '',
      repeatCount: '',
    })
  }
  return {
    startTime: stringify(scenario.startTime),
    endTime: stringify(scenario.endTime),
    outputInterval: outputIntervalOf(scenario.outputTimes),
    centralVolume: { value: stringify(scenario.parameters.centralVolume.value), unit: scenario.parameters.centralVolume.unit },
    peripheralVolume: {
      value: stringify(scenario.parameters.peripheralVolume.value),
      unit: scenario.parameters.peripheralVolume.unit,
    },
    clearance: { value: stringify(scenario.parameters.clearance.value), unit: scenario.parameters.clearance.unit },
    intercompartmentalClearance: {
      value: stringify(scenario.parameters.intercompartmentalClearance.value),
      unit: scenario.parameters.intercompartmentalClearance.unit,
    },
    // A scenario without an effect-site configuration maps to a DISABLED
    // section: no parameter is invented. A configured one keeps its own
    // declared text and units.
    effectSite:
      scenario.effectSite === undefined
        ? emptyEffectSiteDraft()
        : {
            enabled: true,
            unboundFraction: stringify(scenario.effectSite.unboundFraction),
            ke0: stringify(scenario.effectSite.ke0),
            kd: {
              value: stringify(scenario.effectSite.kd.value),
              unit: scenario.effectSite.kd.unit,
            },
            molecularWeight:
              scenario.effectSite.molecularWeight === undefined
                ? ''
                : stringify(scenario.effectSite.molecularWeight.value),
            molecularWeightProvenance: scenario.effectSite.molecularWeightProvenance ?? '',
          },
    initialCentralAmount: stringify(scenario.initialState.centralAmount),
    initialPeripheralAmount: stringify(scenario.initialState.peripheralAmount),
    events: rows,
    solver: {
      absoluteTolerance: stringify(scenario.solver.absoluteTolerance),
      relativeTolerance: stringify(scenario.solver.relativeTolerance),
      initialStep: stringify(scenario.solver.initialStep),
      minStep: stringify(scenario.solver.minStep),
      maxStep: stringify(scenario.solver.maxStep),
      maxSteps: stringify(scenario.solver.maxSteps),
    },
  }
}

/** Uniform interval of an already-built grid; blank when it is not uniform. */
export function outputIntervalOf(times: readonly number[]): string {
  if (times.length < 2) return ''
  const first = times[0] ?? 0
  const second = times[1] ?? first
  return stringify(second - first)
}

// ---------------------------------------------------------------------------
// Compilation
// ---------------------------------------------------------------------------

interface QuantityResult {
  readonly value?: number
  readonly unit: string
}

function readQuantity(
  errors: DraftError[],
  field: string,
  draft: QuantityDraft,
  unitFallback: string,
): QuantityResult {
  const unit = draft.unit.trim() === '' ? unitFallback : draft.unit
  const text = draft.value.trim()
  if (text === '') {
    errors.push({ code: 'REQUIRED', field, message: 'A value is required.' })
    return { unit }
  }
  const value = parseNumericText(text)
  if (value === null) {
    errors.push({
      code: 'NOT_A_NUMBER',
      field,
      message: `Must be a finite number (got "${draft.value}").`,
    })
    return { unit }
  }
  return { value, unit }
}

function readNumber(
  errors: DraftError[],
  field: string,
  text: string,
  options: { readonly integer?: boolean } = {},
): number | undefined {
  if (text.trim() === '') {
    errors.push({ code: 'REQUIRED', field, message: 'A value is required.' })
    return undefined
  }
  const value = parseNumericText(text)
  if (value === null) {
    errors.push({
      code: 'NOT_A_NUMBER',
      field,
      message: `Must be a finite number (got "${text}").`,
    })
    return undefined
  }
  if (options.integer === true && !Number.isInteger(value)) {
    errors.push({ code: 'OUT_OF_RANGE', field, message: `Must be a whole number (got ${text}).` })
    return undefined
  }
  return value
}

/**
 * Stop before start is a user-facing event-session mistake the editor can
 * state precisely; the engine would also reject it (no positive-length
 * interval), so this check never masks a scientific rule — it only helps the
 * user locate the row. Equal values are likewise rejected.
 */
function checkInfusionOrder(errors: DraftError[], row: InfusionRow, start: number, stop: number): boolean {
  if (!(stop > start)) {
    errors.push({
      code: 'OUT_OF_RANGE',
      field: `events.${row.key}.stopTime`,
      message: `An infusion stop time must be later than its start time (start ${start} h, stop ${stop} h).`,
    })
    return false
  }
  return true
}

/**
 * Practical ceiling on the number of doses one row can expand to. It is a
 * guard against pathological input (e.g. a repeat count of 1e12), not a
 * scientific limit; the time horizon bounds every real regimen long before
 * this ceiling is reached.
 */
const MAX_REPEAT_COUNT = 100_000

/** One expanded dose, ready for the editor's "expanded schedule" preview. */
export interface ExpandedDose {
  readonly rowKey: number
  readonly kind: 'bolus' | 'infusion'
  /** 1-based dose number within the row (1 when there is no repeat). */
  readonly doseNumber: number
  /** Engine event ids this dose expands to (1 for a bolus, 2 for an infusion). */
  readonly eventIds: readonly string[]
  /** Bolus time, or infusion start time (hours). */
  readonly time: number
  /** Infusion stop time (hours); present only for infusions. */
  readonly stopTime?: number
  /** Declared bolus amount (present only for boluses). */
  readonly amount?: { readonly value: number; readonly unit: string }
  /** Declared infusion rate (present only for infusions). */
  readonly rate?: { readonly value: number; readonly unit: string }
  /** Infusion duration = stop − start (hours); present only for infusions. */
  readonly duration?: number
}

/** The expanded dosing schedule: flat events plus their display records. */
export interface ExpandedSchedule {
  readonly doses: readonly ExpandedDose[]
  readonly events: readonly DosingEvent[]
  readonly errors: readonly DraftError[]
}

interface RepeatSpec {
  readonly count: number
  readonly interval: number
}

/**
 * Read a row's optional repeat. `repeatCount` is the total number of doses
 * (blank or `1` = a single dose); `repeatInterval` is hours between successive
 * doses and is required (and must be positive) whenever the dose is repeated.
 */
function readRepeatSpec(errors: DraftError[], fieldBase: string, row: EventRow): RepeatSpec {
  const countText = (row.repeatCount ?? '').trim()
  const intervalText = (row.repeatInterval ?? '').trim()

  let count = 1
  if (countText !== '') {
    const parsed = parseNumericText(countText)
    if (parsed === null) {
      errors.push({
        code: 'NOT_A_NUMBER',
        field: `${fieldBase}.repeatCount`,
        message: `Must be a finite number (got "${countText}").`,
      })
    } else if (!Number.isInteger(parsed) || parsed < 1) {
      errors.push({
        code: 'OUT_OF_RANGE',
        field: `${fieldBase}.repeatCount`,
        message: `Must be a positive whole number (got ${countText}).`,
      })
    } else if (parsed > MAX_REPEAT_COUNT) {
      errors.push({
        code: 'OUT_OF_RANGE',
        field: `${fieldBase}.repeatCount`,
        message: `At most ${MAX_REPEAT_COUNT} doses per row are supported (got ${countText}).`,
      })
    } else {
      count = parsed
    }
  }

  let interval = 0
  if (count > 1) {
    if (intervalText === '') {
      errors.push({
        code: 'REQUIRED',
        field: `${fieldBase}.repeatInterval`,
        message: 'A repeat interval is required when a dose is repeated.',
      })
    } else {
      const parsed = parseNumericText(intervalText)
      if (parsed === null) {
        errors.push({
          code: 'NOT_A_NUMBER',
          field: `${fieldBase}.repeatInterval`,
          message: `Must be a finite number (got "${intervalText}").`,
        })
      } else if (parsed <= 0) {
        errors.push({
          code: 'OUT_OF_RANGE',
          field: `${fieldBase}.repeatInterval`,
          message: `Must be greater than 0 (got ${intervalText}).`,
        })
      } else {
        interval = parsed
      }
    }
  }
  // A repeat interval on a single dose is harmless and ignored.

  return { count, interval }
}

/**
 * Expand editor rows into the engine's flat `DosingEvent[]`, applying each
 * row's optional repeat. This is the single place a regimen (with repeats) is
 * turned into an explicit event schedule, and it is pure: no side effects, no
 * engine call, no mutation of the input rows.
 *
 * Event ids stay deterministic: a single dose keeps the historical id
 * (`bolus-<key>`, `infusion-<key>-start/-stop`); a repeated dose appends the
 * 1-based dose number (`bolus-<key>-2`, `infusion-<key>-2-start`, …).
 */
export function expandEventRows(rows: readonly EventRow[]): ExpandedSchedule {
  const errors: DraftError[] = []
  const events: DosingEvent[] = []
  const doses: ExpandedDose[] = []

  for (const row of rows) {
    const fieldBase = `events.${row.key}`
    if (row.kind === 'bolus') {
      const time = readNumber(errors, `${fieldBase}.time`, row.time)
      const amount = readQuantity(errors, `${fieldBase}.amount.value`, row.amount, 'mg')
      if (time === undefined || amount.value === undefined) continue
      const repeat = readRepeatSpec(errors, fieldBase, row)
      for (let k = 1; k <= repeat.count; k += 1) {
        const doseTime = time + (k - 1) * repeat.interval
        const eventId = repeat.count === 1 ? bolusEventId(row.key) : `${bolusEventId(row.key)}-${k}`
        events.push({ type: 'iv-bolus', eventId, time: doseTime, amount: { value: amount.value, unit: amount.unit } })
        doses.push({
          rowKey: row.key,
          kind: 'bolus',
          doseNumber: k,
          eventIds: [eventId],
          time: doseTime,
          amount: { value: amount.value, unit: amount.unit },
        })
      }
    } else {
      const start = readNumber(errors, `${fieldBase}.startTime`, row.startTime)
      const stop = readNumber(errors, `${fieldBase}.stopTime`, row.stopTime)
      const rate = readQuantity(errors, `${fieldBase}.rate.value`, row.rate, 'mg/h')
      if (start === undefined || stop === undefined || rate.value === undefined) continue
      if (!checkInfusionOrder(errors, row, start, stop)) continue
      const duration = stop - start
      const repeat = readRepeatSpec(errors, fieldBase, row)
      // A repeated session whose interval is shorter than its own duration
      // would overlap itself; reject rather than silently summing the rate.
      if (repeat.count > 1 && repeat.interval < duration) {
        errors.push({
          code: 'OUT_OF_RANGE',
          field: `${fieldBase}.repeatInterval`,
          message: `Repeated infusion sessions would overlap: the interval (${repeat.interval} h) is shorter than the session duration (${duration} h).`,
        })
      }
      for (let k = 1; k <= repeat.count; k += 1) {
        const offset = (k - 1) * repeat.interval
        const base = repeat.count === 1 ? infusionIdOf(row.key) : `${infusionIdOf(row.key)}-${k}`
        const startEventId = `${base}-start`
        const stopEventId = `${base}-stop`
        events.push(
          { type: 'infusion-start', eventId: startEventId, infusionId: base, time: start + offset, rate: { value: rate.value, unit: rate.unit } },
          { type: 'infusion-stop', eventId: stopEventId, infusionId: base, time: stop + offset },
        )
        doses.push({
          rowKey: row.key,
          kind: 'infusion',
          doseNumber: k,
          eventIds: [startEventId, stopEventId],
          time: start + offset,
          stopTime: stop + offset,
          rate: { value: rate.value, unit: rate.unit },
          duration,
        })
      }
    }
  }

  return { doses, events, errors }
}

/** Engine events from editor rows; a row with unparseable fields yields errors. */
function compileEvents(errors: DraftError[], rows: readonly EventRow[]): readonly DosingEvent[] {
  const expanded = expandEventRows(rows)
  errors.push(...expanded.errors)
  return expanded.events
}

/**
 * Compile the draft into the engine's scenario.
 *
 * Returns `{ ok: false, errors, gridError }` when a field cannot be parsed or
 * the output grid cannot be built; in that case `simulate()` is never called
 * (there is no scenario to give it). Scientific validation stays with the
 * engine.
 */
export type CompileResult =
  | { readonly ok: true; readonly scenario: SimulationScenario }
  | {
      readonly ok: false
      readonly errors: readonly DraftError[]
      /** Set when the output grid itself was rejected. */
      readonly gridError?: OutputGridResult & { readonly ok: false }
    }

/**
 * Compile the effect-site section into the engine's `EffectSiteInput`.
 *
 * Draft-level parsing only: blank/unparseable numeric text becomes a typed
 * draft error (the engine is never called with an incomplete configuration),
 * and nothing is defaulted. Scientific validation — range, unit dimension,
 * molecular-weight provenance — stays with `resolveEffectSite` in the engine.
 */
function compileEffectSiteDraft(
  section: EffectSiteDraft,
  errors: DraftError[],
): EffectSiteInput | undefined {
  const before = errors.length
  const unboundFraction = readNumber(errors, 'effectSite.unboundFraction', section.unboundFraction)
  const ke0 = readNumber(errors, 'effectSite.ke0', section.ke0)
  const kd = readQuantity(errors, 'effectSite.kd', section.kd, 'mg/L')
  // The molecular weight is OPTIONAL in draft terms: the engine requires it
  // only when Kd is declared in a molar unit. Blank stays absent — never 0.
  const molecularWeightText = section.molecularWeight.trim()
  let molecularWeight: { value: number; unit: string } | undefined
  if (molecularWeightText !== '') {
    const parsed = parseNumericText(molecularWeightText)
    if (parsed === null) {
      errors.push({
        code: 'NOT_A_NUMBER',
        field: 'effectSite.molecularWeight',
        message: `Must be a finite number (got "${section.molecularWeight}").`,
      })
    } else {
      molecularWeight = { value: parsed, unit: 'g/mol' }
    }
  }
  const provenance = section.molecularWeightProvenance.trim()
  if (errors.length > before) return undefined
  if (unboundFraction === undefined || ke0 === undefined || kd.value === undefined) return undefined
  return {
    unboundFraction,
    ke0,
    kd: { value: kd.value, unit: kd.unit },
    ...(molecularWeight === undefined ? {} : { molecularWeight }),
    ...(provenance === '' ? {} : { molecularWeightProvenance: provenance }),
  }
}

export function compileScenario(draft: SimulationDraft): CompileResult {
  const errors: DraftError[] = []

  const centralVolume = readQuantity(errors, 'centralVolume', draft.centralVolume, 'L')
  const peripheralVolume = readQuantity(errors, 'peripheralVolume', draft.peripheralVolume, 'L')
  const clearance = readQuantity(errors, 'clearance', draft.clearance, 'L/h')
  const intercompartmentalClearance = readQuantity(
    errors,
    'intercompartmentalClearance',
    draft.intercompartmentalClearance,
    'L/h',
  )
  const initialCentral = readNumber(errors, 'initialCentralAmount', draft.initialCentralAmount)
  const initialPeripheral = readNumber(errors, 'initialPeripheralAmount', draft.initialPeripheralAmount)
  const startTime = readNumber(errors, 'startTime', draft.startTime)
  const endTime = readNumber(errors, 'endTime', draft.endTime)

  // Output grid: only meaningful once start/end are numbers. The interval is
  // read through the same grid error channel so its message stays specific.
  let grid: OutputGridResult | undefined
  if (startTime !== undefined && endTime !== undefined) {
    if (draft.outputInterval.trim() === '') {
      errors.push({ code: 'REQUIRED', field: 'outputInterval', message: 'A value is required.' })
    } else {
      const parsed = parseNumericText(draft.outputInterval)
      if (parsed === null) {
        errors.push({
          code: 'NOT_A_NUMBER',
          field: 'outputInterval',
          message: `Must be a finite number (got "${draft.outputInterval}").`,
        })
      } else {
        grid = buildOutputGrid(startTime, endTime, parsed)
        if (!grid.ok) {
          errors.push({
            code: grid.code === 'NOT_A_NUMBER' ? 'NOT_A_NUMBER' : 'OUT_OF_RANGE',
            field: grid.field,
            message: grid.message,
          })
        }
      }
    }
  }

  const maxSteps = readNumber(errors, 'solver.maxSteps', draft.solver.maxSteps, { integer: true })
  const absoluteTolerance = readNumber(errors, 'solver.absoluteTolerance', draft.solver.absoluteTolerance)
  const relativeTolerance = readNumber(errors, 'solver.relativeTolerance', draft.solver.relativeTolerance)
  const initialStep = readNumber(errors, 'solver.initialStep', draft.solver.initialStep)
  const minStep = readNumber(errors, 'solver.minStep', draft.solver.minStep)
  const maxStep = readNumber(errors, 'solver.maxStep', draft.solver.maxStep)

  const events = compileEvents(errors, draft.events)

  if (
    errors.length > 0 ||
    grid === undefined ||
    !grid.ok ||
    startTime === undefined ||
    endTime === undefined ||
    centralVolume.value === undefined ||
    peripheralVolume.value === undefined ||
    clearance.value === undefined ||
    intercompartmentalClearance.value === undefined ||
    initialCentral === undefined ||
    initialPeripheral === undefined ||
    absoluteTolerance === undefined ||
    relativeTolerance === undefined ||
    initialStep === undefined ||
    minStep === undefined ||
    maxStep === undefined ||
    maxSteps === undefined
  ) {
    return {
      ok: false,
      errors,
      ...(grid !== undefined && !grid.ok ? { gridError: grid } : {}),
    }
  }

  const solver: SolverOptions = {
    absoluteTolerance,
    relativeTolerance,
    initialStep,
    minStep,
    maxStep,
    maxSteps,
  }
  // Effect-site section (phase 46): opt-in. When disabled it contributes
  // nothing at all — no defaults, no zero-filling, no `effectSite` key.
  let effectSite: EffectSiteInput | undefined
  const effectSiteDraft = draft.effectSite
  if (effectSiteDraft !== undefined && effectSiteDraft.enabled) {
    const parsed = compileEffectSiteDraft(effectSiteDraft, errors)
    if (parsed !== undefined) effectSite = parsed
    else {
      return {
        ok: false,
        errors,
        ...(grid !== undefined && !grid.ok ? { gridError: grid } : {}),
      }
    }
  }
  return {
    ok: true,
    scenario: {
      startTime,
      endTime,
      outputTimes: grid.times,
      initialState: { centralAmount: initialCentral, peripheralAmount: initialPeripheral },
      parameters: {
        centralVolume: { value: centralVolume.value, unit: centralVolume.unit },
        peripheralVolume: { value: peripheralVolume.value, unit: peripheralVolume.unit },
        clearance: { value: clearance.value, unit: clearance.unit },
        intercompartmentalClearance: { value: intercompartmentalClearance.value, unit: intercompartmentalClearance.unit },
      },
      ...(effectSite === undefined ? {} : { effectSite }),
      events,
      solver,
    },
  }
}

/**
 * Attach engine errors to the field paths the editor knows about, so the form
 * can mark the offending control. Unmapped errors stay in the summary.
 */
export function engineErrorFieldPath(error: SimulationError): string | null {
  const field = error.field
  if (field === undefined) return null
  switch (field) {
    case 'parameters.centralVolume':
    case 'parameters.centralVolume.value':
    case 'parameters.centralVolume.unit':
      return 'centralVolume'
    case 'parameters.peripheralVolume':
    case 'parameters.peripheralVolume.value':
    case 'parameters.peripheralVolume.unit':
      return 'peripheralVolume'
    case 'parameters.clearance':
    case 'parameters.clearance.value':
    case 'parameters.clearance.unit':
      return 'clearance'
    case 'parameters.intercompartmentalClearance':
    case 'parameters.intercompartmentalClearance.value':
    case 'parameters.intercompartmentalClearance.unit':
      return 'intercompartmentalClearance'
    case 'initialState.centralAmount':
      return 'initialCentralAmount'
    case 'initialState.peripheralAmount':
      return 'initialPeripheralAmount'
    case 'startTime':
      return 'startTime'
    case 'endTime':
      return 'endTime'
    case 'outputTimes':
      return 'outputInterval'
    case 'solver.absoluteTolerance':
      return 'solver.absoluteTolerance'
    case 'solver.relativeTolerance':
      return 'solver.relativeTolerance'
    case 'solver.initialStep':
      return 'solver.initialStep'
    case 'solver.minStep':
      return 'solver.minStep'
    case 'solver.maxStep':
      return 'solver.maxStep'
    case 'solver.maxSteps':
      return 'solver.maxSteps'
    default:
      return null
  }
}
