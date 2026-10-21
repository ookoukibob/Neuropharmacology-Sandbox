/**
 * Storage schema for saved scenarios (phase 45).
 *
 * Written to the Dexie `scenarios` table (schema version 5, additive) and
 * read back through this schema: a stored record that does not validate is
 * reported as a quarantine-style problem by the repository instead of being
 * trusted. The draft itself is validated structurally here (strings where
 * strings are expected, a known row kind, stable row keys); its SCIENTIFIC
 * validity is never judged at this boundary — blank or unparseable values are
 * legitimate drafts and are validated by the editor's normal path on load.
 */
import { z } from 'zod'
import { MAX_SCENARIO_NAME_LENGTH } from '../../domain/simulation/saved-scenario'

const quantityDraftSchema = z.object({
  value: z.string(),
  unit: z.string(),
})

const bolusRowSchema = z.object({
  kind: z.literal('bolus'),
  key: z.number().int().nonnegative(),
  time: z.string(),
  amount: quantityDraftSchema,
})

const infusionRowSchema = z.object({
  kind: z.literal('infusion'),
  key: z.number().int().nonnegative(),
  startTime: z.string(),
  stopTime: z.string(),
  rate: quantityDraftSchema,
})

const eventRowSchema = z.discriminatedUnion('kind', [bolusRowSchema, infusionRowSchema])

export const simulationDraftSchema = z.object({
  startTime: z.string(),
  endTime: z.string(),
  outputInterval: z.string(),
  centralVolume: quantityDraftSchema,
  peripheralVolume: quantityDraftSchema,
  clearance: quantityDraftSchema,
  intercompartmentalClearance: quantityDraftSchema,
  initialCentralAmount: z.string(),
  initialPeripheralAmount: z.string(),
  events: z.array(eventRowSchema),
  solver: z.object({
    absoluteTolerance: z.string(),
    relativeTolerance: z.string(),
    initialStep: z.string(),
    minStep: z.string(),
    maxStep: z.string(),
    maxSteps: z.string(),
  }),
  /**
   * Effect-site section (phase 46). OPTIONAL: records saved before phase 46
   * have no such key and stay valid (they load with effect-site analysis
   * disabled). Every numeric input is a string, so blank or temporarily
   * unparseable text is stored faithfully — this schema is structural only and
   * never validates the science.
   */
  effectSite: z
    .object({
      enabled: z.boolean(),
      unboundFraction: z.string(),
      ke0: z.string(),
      kd: quantityDraftSchema,
      molecularWeight: z.string(),
      molecularWeightProvenance: z.string(),
    })
    .optional(),
})

const isoDateTime = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)) && /T\d{2}:\d{2}:\d{2}/.test(value), {
    message: 'must be an ISO 8601 date-time string',
  })

/** The stored record shape (keyed by `id` in the `scenarios` table). */
export const savedScenarioSchema = z.object({
  id: z.string().min(1),
  // Trimmed and non-empty on write; a stored blank name is still readable
  // (it is display text, not an identifier) but is reported to the caller.
  name: z.string().min(1).max(MAX_SCENARIO_NAME_LENGTH),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
  draft: simulationDraftSchema,
})

export type SavedScenarioRecord = z.infer<typeof savedScenarioSchema>
