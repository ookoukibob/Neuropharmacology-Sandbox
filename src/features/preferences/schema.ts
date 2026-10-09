/**
 * Application preference schema (phase 9B) — one versioned, device-local
 * record holding *presentation* preferences only.
 *
 * What lives here (and only here):
 * - `theme`: the appearance preference (`system | light | dark`);
 * - `calculator.settings`: the per-model curve display defaults the
 *   calculator starts with — explicit range, points, x/y scales.
 *
 * What deliberately does NOT live here: scientific input drafts,
 * calculation reports, curve data, drug-library records, provenance,
 * session state — none of it is a presentation preference and none of it
 * is read or written by this module (ADR-19).
 *
 * Validation is layered like the rest of the app (ADR-4): Zod checks the
 * structure and value formats, then the engine's own `validateCurveOptions`
 * checks the cross-field curve rules, so a persisted default can never
 * hold a range the engine would reject at apply time. Unknown model ids
 * are stripped rather than applied (ADR-8's loose-unknown-keys rule);
 * missing models fall back to the calculator's application defaults —
 * defined exactly once in `features/calculator/store.ts`.
 */
import { z } from 'zod'
import {
  MAX_CURVE_POINTS,
  MIN_CURVE_POINTS,
  validateCurveOptions,
  type ModelId,
} from '@/engine'
import {
  defaultCalculatorSettings,
  type CurveSettings,
} from '@/features/calculator/store'
import { NUMBER_PATTERN } from '@/features/calculator/schemas'

/** Persisted structure version — any other value is rejected, not guessed at. */
export const PREFERENCES_VERSION = 1

/** Namespaced storage key; the version lives inside the record (ADR-19). */
export const PREFERENCES_STORAGE_KEY = 'neuropharmacology-sandbox.preferences'

export type ThemePreference = 'system' | 'light' | 'dark'

/** The validated, fully merged record as storage and the store see it. */
export interface StoredPreferences {
  readonly version: typeof PREFERENCES_VERSION
  readonly theme: ThemePreference
  readonly calculator: {
    readonly settings: Record<ModelId, CurveSettings>
  }
}

function isBlank(value: string): boolean {
  return value.trim() === ''
}

/** A curve bound: blank (not configured) or a finite, non-negative number. */
const rangeBoundText = z
  .string()
  .refine(
    (value) =>
      isBlank(value) ||
      (NUMBER_PATTERN.test(value.trim()) &&
        Number.isFinite(Number(value)) &&
        Number(value) >= 0),
    'Enter a finite number of zero or more, or leave the field blank.',
  )

/** Sample count: blank (the engine default) or an in-range whole number. */
const rangePointsText = z
  .string()
  .refine(
    (value) =>
      isBlank(value) ||
      (/^\d+$/.test(value.trim()) &&
        Number.isInteger(Number(value)) &&
        Number(value) >= MIN_CURVE_POINTS &&
        Number(value) <= MAX_CURVE_POINTS),
    `Enter a whole number between ${MIN_CURVE_POINTS} and ${MAX_CURVE_POINTS}, or leave the field blank.`,
  )

const scaleSchema = z.enum(['linear', 'log'])

/**
 * A stored per-model entry. Leaves are optional so a partial record merges
 * over the application defaults instead of being discarded wholesale; a
 * leaf that *is* present must be well formed.
 */
const storedCurveSettingsSchema = z.object({
  range: z
    .object({
      min: rangeBoundText.optional(),
      max: rangeBoundText.optional(),
      points: rangePointsText.optional(),
    })
    .optional(),
  xScale: scaleSchema.optional(),
  yScale: scaleSchema.optional(),
})

type StoredCurveSettings = z.infer<typeof storedCurveSettingsSchema>

/** Unknown model ids are stripped by the object schema (never applied). */
const storedSettingsSchema = z.object({
  'pk.first-order-one-compartment': storedCurveSettingsSchema.optional(),
  'occupancy.single-site': storedCurveSettingsSchema.optional(),
  'dose-response.hill': storedCurveSettingsSchema.optional(),
})

const preferencesSchema = z.object({
  version: z.literal(PREFERENCES_VERSION),
  theme: z.enum(['system', 'light', 'dark']),
  calculator: z.object({ settings: storedSettingsSchema }),
})

function mergeOne(
  base: CurveSettings,
  stored: StoredCurveSettings | undefined,
): CurveSettings {
  if (stored === undefined) return base
  return {
    range: {
      min: stored.range?.min ?? base.range.min,
      max: stored.range?.max ?? base.range.max,
      points: stored.range?.points ?? base.range.points,
    },
    xScale: stored.xScale ?? base.xScale,
    yScale: stored.yScale ?? base.yScale,
  }
}

/**
 * The engine's own curve rules for a fully entered range (min < max,
 * log-safe min, in-range points). A blank/partial range has no domain to
 * check yet — the engine rejects it at apply time exactly as before.
 * Returns the engine's messages joined, or null when the range is fine.
 */
export function crossRangeError(settings: CurveSettings): string | null {
  const { min, max, points } = settings.range
  if (isBlank(min) || isBlank(max)) return null
  const pointsValue = isBlank(points) ? undefined : Number(points)
  const check = validateCurveOptions(
    {
      range:
        pointsValue === undefined
          ? { min: Number(min), max: Number(max) }
          : { min: Number(min), max: Number(max), points: pointsValue },
      xScale: settings.xScale,
      yScale: settings.yScale,
    },
    settings.xScale,
  )
  if (check.ok) return null
  return check.errors.map((error) => error.message).join(' ')
}

export type PreferencesValidation =
  | { readonly ok: true; readonly preferences: StoredPreferences }
  | { readonly ok: false }

/**
 * Validate an unknown value (already JSON-parsed) into a complete record:
 * structure and formats via Zod, cross-field curve rules via the engine.
 * Any failure rejects the whole record — the caller falls back to the
 * documented defaults rather than applying half of it.
 */
export function validatePreferences(value: unknown): PreferencesValidation {
  const parsed = preferencesSchema.safeParse(value)
  if (!parsed.success) return { ok: false }

  const defaults = defaultCalculatorSettings()
  const stored = parsed.data.calculator.settings
  const settings: Record<ModelId, CurveSettings> = {
    'pk.first-order-one-compartment': mergeOne(
      defaults['pk.first-order-one-compartment'],
      stored['pk.first-order-one-compartment'],
    ),
    'occupancy.single-site': mergeOne(
      defaults['occupancy.single-site'],
      stored['occupancy.single-site'],
    ),
    'dose-response.hill': mergeOne(
      defaults['dose-response.hill'],
      stored['dose-response.hill'],
    ),
  }

  const candidates = [
    settings['pk.first-order-one-compartment'],
    settings['occupancy.single-site'],
    settings['dose-response.hill'],
  ]
  for (const candidate of candidates) {
    if (crossRangeError(candidate) !== null) return { ok: false }
  }

  return {
    ok: true,
    preferences: {
      version: PREFERENCES_VERSION,
      theme: parsed.data.theme,
      calculator: { settings },
    },
  }
}

/**
 * Build the record to persist from live state. Returns null when the
 * candidate would not survive a reload — the store refuses to write it.
 */
export function toStoredPreferences(
  theme: ThemePreference,
  settings: Record<ModelId, CurveSettings>,
): StoredPreferences | null {
  const result = validatePreferences({
    version: PREFERENCES_VERSION,
    theme,
    calculator: { settings },
  })
  return result.ok ? result.preferences : null
}

export type RangeField = 'min' | 'max' | 'points'

const rangeFieldSchemas = {
  min: rangeBoundText,
  max: rangeBoundText,
  points: rangePointsText,
} as const

/** Field-level format check for one range field; null means acceptable. */
export function rangeFieldError(field: RangeField, text: string): string | null {
  const result = rangeFieldSchemas[field].safeParse(text)
  if (result.success) return null
  return result.error.issues[0]?.message ?? 'Invalid value.'
}
