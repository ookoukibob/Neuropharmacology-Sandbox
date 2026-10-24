import { describe, expect, it } from 'vitest'
import type {
  ExperimentalDataset,
  ExperimentalDatasetInput,
} from '@/domain/experiments/experimental-dataset'
import {
  NPEX_FORMAT_ID,
  NPEX_VERSION,
  buildNpexFile,
  checkNpexVersion,
  parseNpexText,
} from './npex'

const EXPORTED_AT = '2026-02-03T04:05:06.000Z'

const INPUT: ExperimentalDatasetInput = {
  name: 'Replicate study',
  timeUnit: 'min',
  concentrationUnit: 'µM',
  notes: ' Study-level note measured at 5 min ',
  provenance: {
    source: 'csv',
    fileName: 'replicates.csv',
    importedAt: '2026-01-01T00:00:00.000Z',
  },
  measurements: [
    { sourceRow: 1, time: 0, concentration: 0, sampleId: ' S-01 ', note: ' measured at 5 min ' },
    { sourceRow: 2, time: 0, concentration: 0, sampleId: ' S-01 ', note: 'exact replicate' },
    { sourceRow: 3, time: 1.5, concentration: 2.25, sampleId: 'B' },
    { sourceRow: 4, time: 1.5, concentration: 2.25, sampleId: 'B', note: 'duplicate time' },
  ],
}

function stored(): ExperimentalDataset {
  return {
    id: 'dataset-local-id',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
    ...INPUT,
    measurements: INPUT.measurements.map((measurement, index) => ({
      id: `measurement-local-id-${String(index)}`,
      ...measurement,
    })),
  }
}

describe('.npex experimental dataset format', () => {
  it('round-trips every scientific value, order, replicate id, note and provenance', () => {
    const built = buildNpexFile(stored(), EXPORTED_AT)
    if (!built.ok) throw new Error(JSON.stringify(built.issues))

    const doc = JSON.parse(built.text) as Record<string, unknown>
    expect(doc['formatId']).toBe(NPEX_FORMAT_ID)
    expect(doc['formatVersion']).toBe(NPEX_VERSION)
    expect(doc['exportedAt']).toBe(EXPORTED_AT)
    expect(built.text).not.toContain('dataset-local-id')
    expect(built.text).not.toContain('measurement-local-id')
    expect(built.text).not.toContain('createdAt')
    expect(built.text).not.toContain('updatedAt')

    const parsed = parseNpexText(built.text)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    expect(parsed.exportedAt).toBe(EXPORTED_AT)
    expect(parsed.dataset).toEqual(INPUT)
  })

  it('accepts zero values, decimal and scientific notation exactly', () => {
    const input: ExperimentalDatasetInput = {
      ...INPUT,
      measurements: [
        { sourceRow: 1, time: 0, concentration: 0 },
        { sourceRow: 2, time: 1e-9, concentration: 2.5e-12 },
      ],
    }
    const built = buildNpexFile(
      {
        ...stored(),
        measurements: input.measurements.map((measurement, index) => ({
          id: `measurement-${String(index)}`,
          ...measurement,
        })),
      },
      EXPORTED_AT,
    )
    if (!built.ok) throw new Error(JSON.stringify(built.issues))
    const parsed = parseNpexText(built.text)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    expect(parsed.dataset.measurements).toEqual(input.measurements)
  })

  it('round-trips administration metadata and accepts files without it', () => {
    const withAdmin: ExperimentalDataset = {
      ...stored(),
      administration: {
        route: 'iv-bolus',
        regimen: 'single-dose',
        timeReference: 'dose-time',
        dose: { value: 100, unit: 'mg' },
      },
    }
    const built = buildNpexFile(withAdmin, EXPORTED_AT)
    if (!built.ok) throw new Error(JSON.stringify(built.issues))
    const parsed = parseNpexText(built.text)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    expect(parsed.dataset.administration).toEqual({
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      dose: { value: 100, unit: 'mg' },
    })

    // A pre-50A file (no administration key) still parses and yields no
    // administration metadata — nothing is invented.
    const legacy = buildNpexFile(stored(), EXPORTED_AT)
    if (!legacy.ok) throw new Error('setup')
    const parsedLegacy = parseNpexText(legacy.text)
    if (!parsedLegacy.ok) throw new Error('setup')
    expect(parsedLegacy.dataset.administration).toBeUndefined()
  })

  it('round-trips the dose basis and reads 1.1.0 files that predate it', () => {
    const withBasis: ExperimentalDataset = {
      ...stored(),
      administration: {
        route: 'iv-bolus',
        regimen: 'repeated-dose-steady-state',
        timeReference: 'dose-time',
        dose: { value: 50, unit: 'mg' },
        doseBasis: 'per-administration',
        dosingInterval: { value: 8, unit: 'h' },
      },
    }
    const built = buildNpexFile(withBasis, EXPORTED_AT)
    if (!built.ok) throw new Error(JSON.stringify(built.issues))
    const parsed = parseNpexText(built.text)
    if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues))
    expect(parsed.dataset.administration?.doseBasis).toBe('per-administration')

    // A 1.1.0 file (recorded before this phase) has no doseBasis. It must load
    // with the field absent rather than defaulted to a per-dose amount.
    const doc = JSON.parse(built.text) as { formatVersion: string; dataset: { administration: Record<string, unknown> } }
    doc.formatVersion = '1.1.0'
    delete doc.dataset.administration['doseBasis']
    const legacy = parseNpexText(JSON.stringify(doc))
    if (!legacy.ok) throw new Error(JSON.stringify(legacy.issues))
    expect(legacy.dataset.administration?.doseBasis).toBeUndefined()
    expect(legacy.dataset.administration?.dose).toEqual({ value: 50, unit: 'mg' })

    // A 1.0.0 file without any administration key is still readable.
    const oldest = JSON.parse(built.text) as { formatVersion: string; dataset: Record<string, unknown> }
    oldest.formatVersion = '1.0.0'
    delete oldest.dataset['administration']
    const noAdmin = parseNpexText(JSON.stringify(oldest))
    if (!noAdmin.ok) throw new Error(JSON.stringify(noAdmin.issues))
    expect(noAdmin.dataset.administration).toBeUndefined()
  })

  it('rejects an unknown dose basis value', () => {
    const built = buildNpexFile(stored(), EXPORTED_AT)
    if (!built.ok) throw new Error('setup')
    const base = JSON.parse(built.text) as { dataset: Record<string, unknown> }
    base.dataset.administration = {
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      dose: { value: 100, unit: 'mg' },
      doseBasis: 'per-dose', // not one of the documented bases
    }
    const parsed = parseNpexText(JSON.stringify(base))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.some((entry) => entry.path === 'dataset.administration.doseBasis')).toBe(true)

    // A basis without an amount is also refused: it would describe nothing.
    base.dataset.administration = {
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      doseBasis: 'per-administration',
    }
    const orphan = parseNpexText(JSON.stringify(base))
    expect(orphan.ok).toBe(false)
    if (orphan.ok) return
    expect(orphan.issues.some((entry) => entry.message.includes('requires a recorded dose'))).toBe(true)
  })

  it('rejects malformed administration metadata without producing a dataset', () => {    const built = buildNpexFile(stored(), EXPORTED_AT)
    if (!built.ok) throw new Error('setup')
    const base = JSON.parse(built.text) as { dataset: Record<string, unknown> }
    base.dataset.administration = {
      route: 'iv-bolus',
      regimen: 'single-dose',
      timeReference: 'dose-time',
      dose: { value: 100, unit: 'mg/L' }, // mass concentration, not a mass
    }
    const parsed = parseNpexText(JSON.stringify(base))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues.some((entry) => entry.code === 'NPEX_VALIDATION')).toBe(true)
    expect(parsed.issues.some((entry) => entry.path === 'dataset.administration.dose.unit')).toBe(true)
  })

  it('uses an independent semantic-version compatibility rule', () => {
    expect(checkNpexVersion('1.0.0').ok).toBe(true)
    expect(checkNpexVersion('1.0.99').ok).toBe(true)
    expect(checkNpexVersion('1.1.0').ok).toBe(true)
    expect(checkNpexVersion('1.2.0').ok).toBe(true)
    expect(checkNpexVersion('1.3.0').ok).toBe(false)
    expect(checkNpexVersion('2.0.0').ok).toBe(false)
    expect(checkNpexVersion('1.0').ok).toBe(false)

    const built = buildNpexFile(stored(), EXPORTED_AT)
    if (!built.ok) throw new Error('setup')
    const doc = JSON.parse(built.text) as Record<string, unknown>
    doc['formatVersion'] = '1.3.0'
    const parsed = parseNpexText(JSON.stringify(doc))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues[0]?.code).toBe('NPEX_VERSION')
    expect(parsed.issues[0]?.message).toContain('newer than supported')
  })

  it('rejects unknown keys at every level', () => {
    const built = buildNpexFile(stored(), EXPORTED_AT)
    if (!built.ok) throw new Error('setup')
    const base = JSON.parse(built.text) as Record<string, unknown>

    const envelope = { ...base, unexpected: true }
    expect(parseNpexText(JSON.stringify(envelope))).toMatchObject({ ok: false })

    const dataset = base['dataset'] as Record<string, unknown>
    const datasetExtra = { ...base, dataset: { ...dataset, unitInferred: true } }
    const parsedDataset = parseNpexText(JSON.stringify(datasetExtra))
    expect(parsedDataset.ok).toBe(false)
    if (!parsedDataset.ok) expect(parsedDataset.issues[0]?.path).toContain('dataset')

    const measurements = dataset['measurements'] as Record<string, unknown>[]
    const measurementExtra = {
      ...base,
      dataset: {
        ...dataset,
        measurements: [{ ...measurements[0], ignored: 1 }],
      },
    }
    const parsedMeasurement = parseNpexText(JSON.stringify(measurementExtra))
    expect(parsedMeasurement.ok).toBe(false)
    if (!parsedMeasurement.ok) {
      expect(parsedMeasurement.issues[0]?.path).toContain('dataset.measurements.0')
    }
  })

  it('rejects bad units and negative/non-finite values with a measurement path', () => {
    const built = buildNpexFile(stored(), EXPORTED_AT)
    if (!built.ok) throw new Error('setup')
    const base = JSON.parse(built.text) as {
      dataset: {
        timeUnit: string
        measurements: Record<string, unknown>[]
      }
    }

    base.dataset.timeUnit = 'mg/L'
    const unitIssues = parseNpexText(JSON.stringify(base))
    expect(unitIssues.ok).toBe(false)
    if (!unitIssues.ok) {
      expect(unitIssues.issues.some((entry) => entry.path === 'dataset.timeUnit')).toBe(true)
    }

    base.dataset.timeUnit = 'h'
    base.dataset.measurements[2]!['concentration'] = -1
    const negative = parseNpexText(JSON.stringify(base))
    expect(negative.ok).toBe(false)
    if (!negative.ok) {
      expect(negative.issues.some((entry) => entry.path === 'dataset.measurements.2.concentration')).toBe(
        true,
      )
    }

    base.dataset.measurements[2]!['concentration'] = null
    const notFinite = parseNpexText(JSON.stringify(base))
    expect(notFinite.ok).toBe(false)
  })

  it('rejects duplicate JSON keys instead of keeping the last value silently', () => {
    const duplicate = `{
      "formatId": "npex",
      "formatVersion": "1.0.0",
      "formatVersion": "1.0.0",
      "exportedAt": "2026-01-01T00:00:00.000Z",
      "dataset": {}
    }`
    const parsed = parseNpexText(duplicate)
    expect(parsed.ok).toBe(false)
    if (parsed.ok) return
    expect(parsed.issues[0]?.code).toBe('NPEX_DUPLICATE_JSON_KEY')
  })

  it('rejects a non-npex envelope and malformed JSON', () => {
    const notNpex = parseNpexText(
      JSON.stringify({
        formatId: 'other',
        formatVersion: '1.0.0',
        exportedAt: EXPORTED_AT,
        dataset: {},
      }),
    )
    expect(notNpex.ok).toBe(false)
    if (!notNpex.ok) expect(notNpex.issues[0]?.code).toBe('NPEX_ENVELOPE')

    const malformed = parseNpexText('{')
    expect(malformed.ok).toBe(false)
    if (!malformed.ok) expect(malformed.issues[0]?.code).toBe('NPEX_PARSE')
  })

  it('refuses to build from invalid stored content instead of exporting it', () => {
    const invalid: ExperimentalDataset = {
      ...stored(),
      timeUnit: 'mg/L',
      measurements: [{ ...stored().measurements[0]!, time: -1 }],
    }
    const built = buildNpexFile(invalid, EXPORTED_AT)
    expect(built.ok).toBe(false)
    if (built.ok) return
    expect(built.issues.some((entry) => entry.code === 'NPEX_EXPORT_VALIDATION')).toBe(true)
  })
})
