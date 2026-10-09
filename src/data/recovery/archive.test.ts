/**
 * `.npsb` archive tests (docs/recovery-backup.md §4–§9): the export
 * pipeline with its verification gate, the full §8.2 validation battery
 * in order, the backupVersion rule, and the §8.3 warnings. All fixtures
 * are synthetic test data — not pharmacological information.
 */
import { describe, expect, it, vi } from 'vitest'
import { toRecord } from '../mappers/records'
import { syntheticDrug } from '../../tests/fixtures'
import {
  buildRecoveryArchive,
  buildRecoveryWarnings,
  classifyArchiveDrugs,
  parseRecoveryArchive,
  type BuildArchiveInput,
  type BuildArchiveResult,
  type ParseArchiveResult,
  type RawSnapshotRow,
} from './archive'
import {
  MAX_ARCHIVE_BYTES,
  MAX_META_ROWS,
  checkBackupVersion,
  type RecoveryErrorCode,
  type RecoveryIssue,
} from './format'

const STORAGE = { databaseVersion: 2, persistenceVersion: 2 }
const EXPORTED_AT = '2026-01-01T00:00:00.000Z'

const META_VALUE = {
  id: 'local-library',
  name: 'Synthetic fixture library',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  dataStatus: 'example',
}

function validDrugRow(): RawSnapshotRow {
  const record = toRecord(syntheticDrug())
  return { key: record.id, value: record }
}

function baseInput(): BuildArchiveInput {
  return {
    drugs: [validDrugRow()],
    meta: [{ key: 'local-library', value: META_VALUE }],
    storage: STORAGE,
    exportedAt: EXPORTED_AT,
  }
}

function buildOk(
  input: Partial<BuildArchiveInput> = {},
): Extract<BuildArchiveResult, { readonly ok: true }> {
  const result = buildRecoveryArchive({ ...baseInput(), ...input })
  if (!result.ok) throw new Error(`expected build success: ${JSON.stringify(result.issues)}`)
  return result
}

/** Build a valid archive, JSON-mutate the envelope, re-serialize. */
function mutateDoc(mutate: (doc: Record<string, unknown>) => void): string {
  const result = buildOk()
  if (!result.ok) throw new Error('unreachable')
  const doc = JSON.parse(result.text) as Record<string, unknown>
  mutate(doc)
  return JSON.stringify(doc)
}

function rejection(result: ParseArchiveResult, code: RecoveryErrorCode): RecoveryIssue {
  if (result.ok) throw new Error('expected a rejection, got ok:true')
  const issue = result.issues.find((candidate) => candidate.code === code)
  if (issue === undefined) {
    throw new Error(
      `expected ${code}, got: ${JSON.stringify(result.issues.map((candidate) => candidate.code))}`,
    )
  }
  return issue
}

describe('buildRecoveryArchive (export)', () => {
  it('builds a verified .npsb archive with the exact envelope, counts and sidecars', () => {
    const record = toRecord(syntheticDrug())
    const value: Record<string, unknown> = {
      ...record,
      futureField: { note: 'unknown key carried verbatim' },
      nan: NaN,
      negZero: -0,
      posInf: Infinity,
    }
    const result = buildOk({
      drugs: [
        { key: record.id, value },
        { key: 'bad-row', value: { id: 'bad-row', name: 123 } },
      ],
    })
    if (!result.ok) throw new Error('unreachable')
    expect(result.counts).toEqual({
      drugRows: 2,
      readableAtExport: 1,
      quarantinedAtExport: 1,
      metaRows: 1,
    })

    const doc = JSON.parse(result.text) as Record<string, unknown>
    expect(Object.keys(doc).sort()).toEqual([
      'backupVersion',
      'counts',
      'drugs',
      'exportedAt',
      'formatId',
      'meta',
      'storage',
    ])
    expect(doc['formatId']).toBe('npsb')
    expect(doc['backupVersion']).toBe('1.0.0')
    expect(doc['exportedAt']).toBe(EXPORTED_AT)
    expect(doc['storage']).toEqual(STORAGE)
    expect(doc['counts']).toEqual(result.counts)

    const drugs = doc['drugs'] as { key: string; specialNumbers?: unknown[] }[]
    expect(drugs.map((entry) => entry.key)).toEqual([record.id, 'bad-row'])
    // Sidecar annotations carry RFC 6901 paths; the TEXT itself holds
    // only JSON-representable placeholders — no bare NaN/Infinity/-0.
    expect(drugs[0]?.specialNumbers).toEqual(
      expect.arrayContaining([
        { path: '/nan', kind: 'NaN' },
        { path: '/negZero', kind: '-0' },
        { path: '/posInf', kind: 'Infinity' },
      ]),
    )
    // §6.2: the TEXT carries only JSON-representable placeholders — never
    // a bare NaN/Infinity/-0 value token (the quoted kind strings are
    // sidecar data, not values).
    expect(result.text).toContain('"nan": null')
    expect(result.text).toContain('"posInf": null')
    expect(result.text).toContain('"negZero": 0')
    expect(result.text).not.toMatch(/: NaN\b/)
    expect(result.text).not.toMatch(/: Infinity\b/)
    expect(result.text).not.toMatch(/: -0\b/)

    // And it parses back losslessly through the restore validation.
    const parsed = parseRecoveryArchive(result.text)
    if (!parsed.ok) throw new Error(`round trip failed: ${JSON.stringify(parsed.issues)}`)
    expect(parsed.archive.counts).toEqual(result.counts)
    const restored = parsed.archive.drugs[0]?.value
    expect(restored?.['futureField']).toEqual({ note: 'unknown key carried verbatim' })
    expect(Number.isNaN(restored?.['nan'] as number)).toBe(true)
    expect(Object.is(restored?.['negZero'], -0)).toBe(true)
    expect(restored?.['posInf']).toBe(Infinity)
  })

  it('fails the whole export with diagnostics for any unsupported value', () => {
    const record = toRecord(syntheticDrug())
    const cases: readonly [unknown, string][] = [
      [new Date(), 'date'],
      [BigInt(7), 'bigint'],
      [new Map(), 'map'],
      [undefined, 'undefined'],
    ]
    for (const [poison, type] of cases) {
      const result = buildRecoveryArchive({
        ...baseInput(),
        drugs: [{ key: record.id, value: { ...record, poison } }],
      })
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected failure')
      const issue = result.issues[0]
      expect(issue?.code).toBe('BACKUP_UNSUPPORTED_VALUE')
      expect(issue?.store).toBe('drugs')
      expect(issue?.key).toBe(record.id)
      expect(issue?.path).toBe('/poison')
      expect(issue?.valueType).toBe(type)
    }
  })

  it('rejects non-string primary keys and key/id disagreements', () => {
    const nonString = buildRecoveryArchive({
      ...baseInput(),
      meta: [{ key: 42, value: META_VALUE }],
    })
    expect(nonString.ok).toBe(false)
    if (nonString.ok) throw new Error('expected failure')
    expect(nonString.issues[0]?.code).toBe('BACKUP_UNSUPPORTED_KEY')
    expect(nonString.issues[0]?.valueType).toBe('number')

    const record = toRecord(syntheticDrug())
    const mismatch = buildRecoveryArchive({
      ...baseInput(),
      drugs: [{ key: record.id, value: { ...record, id: 'other-id' } }],
    })
    expect(mismatch.ok).toBe(false)
    if (mismatch.ok) throw new Error('expected failure')
    expect(mismatch.issues[0]?.code).toBe('BACKUP_UNSUPPORTED_VALUE')
    expect(mismatch.issues[0]?.path).toBe('/id')
  })

  it('enforces export-side limits so no un-restorable archive is ever produced', () => {
    const metaRows: RawSnapshotRow[] = Array.from({ length: MAX_META_ROWS + 1 }, (_, i) => ({
      key: `m${i}`,
      value: { ...META_VALUE, id: `m${i}` },
    }))
    const result = buildRecoveryArchive({ ...baseInput(), meta: metaRows })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected failure')
    expect(result.issues[0]?.code).toBe('BACKUP_LIMIT_EXCEEDED')
    expect(result.issues[0]?.limit).toBe('meta rows')
  })

  it('fails closed with BACKUP_VERIFY_FAILED when verification detects a mismatch', () => {
    const realStringify = JSON.stringify.bind(JSON)

    // (a) Tampered counts after assembly.
    const countsSpy = vi.spyOn(JSON, 'stringify').mockImplementationOnce((value: unknown) => {
      const doc = value as { counts: { drugRows: number } }
      doc.counts.drugRows = 999
      return realStringify(value, null, 2)
    })
    try {
      const result = buildRecoveryArchive(baseInput())
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected verification failure')
      expect(result.issues[0]?.code).toBe('BACKUP_VERIFY_FAILED')
      expect(result.issues[0]?.message).toContain('counts')
    } finally {
      countsSpy.mockRestore()
    }

    // (b) A row value that differs from the source snapshot after the
    // serialize → parse → materialize round trip.
    const valueSpy = vi.spyOn(JSON, 'stringify').mockImplementationOnce((value: unknown) => {
      const clone = JSON.parse(realStringify(value)) as {
        drugs: { value: Record<string, unknown> }[]
      }
      clone.drugs[0]!.value['injected'] = 'tampered'
      return realStringify(clone, null, 2)
    })
    try {
      const result = buildRecoveryArchive(baseInput())
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('expected verification failure')
      expect(result.issues[0]?.code).toBe('BACKUP_VERIFY_FAILED')
      expect(result.issues[0]?.message).toContain('differs from the source snapshot')
    } finally {
      valueSpy.mockRestore()
    }
  })
})

describe('parseRecoveryArchive (restore validation battery)', () => {
  it('accepts a valid archive and materializes its sidecar', () => {
    const result = buildOk({
      drugs: [
        {
          key: 'fixture-drug-1',
          value: { id: 'fixture-drug-1', nan: null, nested: [{ z: null }] },
        },
      ],
      meta: [],
    })
    if (!result.ok) throw new Error('unreachable')
    // Attach annotations by hand-equivalent mutation: rewrite the entry.
    const doc = JSON.parse(result.text) as Record<string, unknown>
    const drugs = doc['drugs'] as Record<string, unknown>[]
    drugs[0]!['specialNumbers'] = [
      { path: '/nan', kind: 'NaN' },
      { path: '/nested/0/z', kind: '-Infinity' },
    ]
    const parsed = parseRecoveryArchive(JSON.stringify(doc))
    if (!parsed.ok) throw new Error(`expected ok: ${JSON.stringify(parsed.issues)}`)
    const value = parsed.archive.drugs[0]?.value
    expect(Number.isNaN(value?.['nan'] as number)).toBe(true)
    const nested = value?.['nested'] as { z: number }[] | undefined
    expect(nested?.[0]?.z).toBe(-Infinity)
    expect(parsed.archive.counts).toEqual(result.counts)
  })

  it('rejects oversized text before parsing (ARCHIVE_TOO_LARGE)', () => {
    const oversized = 'a'.repeat(MAX_ARCHIVE_BYTES + 1)
    const parsed = parseRecoveryArchive(oversized)
    const issue = rejection(parsed, 'ARCHIVE_TOO_LARGE')
    expect(issue.message).toContain(String(MAX_ARCHIVE_BYTES))
  })

  it('rejects duplicate JSON keys before JSON.parse (ARCHIVE_DUPLICATE_JSON_KEY)', () => {
    const { text } = buildOk()
    const duplicated = text.replace(
      '"formatId": "npsb"',
      '"formatId": "npsb",\n  "formatId": "npsb"',
    )
    const issue = rejection(parseRecoveryArchive(duplicated), 'ARCHIVE_DUPLICATE_JSON_KEY')
    expect(issue.message).toContain('formatId')
    expect(issue.message).toContain('line')
    expect(issue.message).toContain('column')
  })

  it('rejects pathological nesting before JSON.parse can blow the stack', () => {
    const deep = '['.repeat(101) + ']'.repeat(101)
    const issue = rejection(parseRecoveryArchive(deep), 'ARCHIVE_LIMIT_EXCEEDED')
    expect(issue.limit).toBe('depth')
    expect(issue.message).toContain('100')
  })

  it('reports invalid JSON as ARCHIVE_PARSE', () => {
    const issue = rejection(parseRecoveryArchive('{"formatId":'), 'ARCHIVE_PARSE')
    expect(issue.message).toContain('not valid JSON')
    expect(rejection(parseRecoveryArchive('not json'), 'ARCHIVE_PARSE')).toBeDefined()
  })

  it('requires the exact seven-key envelope (ARCHIVE_ENVELOPE_SHAPE)', () => {
    expect(rejection(parseRecoveryArchive('[]'), 'ARCHIVE_ENVELOPE_SHAPE').message).toContain(
      'root must be a JSON object',
    )

    const extra = mutateDoc((doc) => {
      doc['extra'] = 1
    })
    expect(rejection(parseRecoveryArchive(extra), 'ARCHIVE_ENVELOPE_SHAPE').message).toContain(
      'extra',
    )

    const missing = mutateDoc((doc) => {
      delete doc['exportedAt']
    })
    expect(rejection(parseRecoveryArchive(missing), 'ARCHIVE_ENVELOPE_SHAPE').message).toContain(
      'exportedAt',
    )

    const badDate = mutateDoc((doc) => {
      doc['exportedAt'] = 'yesterday'
    })
    rejection(parseRecoveryArchive(badDate), 'ARCHIVE_ENVELOPE_SHAPE')

    const badStorage = mutateDoc((doc) => {
      doc['storage'] = { databaseVersion: 'two', persistenceVersion: 2 }
    })
    rejection(parseRecoveryArchive(badStorage), 'ARCHIVE_ENVELOPE_SHAPE')

    const badArrays = mutateDoc((doc) => {
      doc['drugs'] = {}
    })
    rejection(parseRecoveryArchive(badArrays), 'ARCHIVE_ENVELOPE_SHAPE')
  })

  it('rejects foreign files with import guidance (ARCHIVE_NOT_NPSB)', () => {
    const foreign = mutateDoc((doc) => {
      doc['formatId'] = 'npsl-file'
    })
    const issue = rejection(parseRecoveryArchive(foreign), 'ARCHIVE_NOT_NPSB')
    expect(issue.message).toContain('Import tab')

    // A real .npsl document declares no formatId at all: mutual
    // rejection with the ordinary import path (covered from both sides).
    const npsl = JSON.stringify({
      formatVersion: '1.0.0',
      schemaVersion: '1.0.0',
      libraryMetadata: META_VALUE,
      drugs: [],
    })
    rejection(parseRecoveryArchive(npsl), 'ARCHIVE_NOT_NPSB')
  })

  it('applies the backupVersion compatibility rule (ARCHIVE_VERSION)', () => {
    const noVersion = mutateDoc((doc) => {
      delete doc['backupVersion']
    })
    expect(rejection(parseRecoveryArchive(noVersion), 'ARCHIVE_VERSION').message).toContain(
      'semantic version string',
    )

    for (const [version, needle] of [
      ['2.0.0', 'Major version 2'],
      ['1.1.0', 'Minor version'],
      ['1.0.x', 'not a valid semantic version'],
      ['garbage', 'not a valid semantic version'],
    ] as const) {
      const doc = mutateDoc((target) => {
        target['backupVersion'] = version
      })
      expect(rejection(parseRecoveryArchive(doc), 'ARCHIVE_VERSION').message).toContain(needle)
    }

    // The rule itself: same major, file minor <= reader minor; patch free.
    expect(checkBackupVersion('1.0.0').ok).toBe(true)
    expect(checkBackupVersion('1.0.99').ok).toBe(true)
    expect(checkBackupVersion('0.9.9').ok).toBe(false)
    expect(checkBackupVersion('2.0.0').ok).toBe(false)
    expect(checkBackupVersion('1.1.0').ok).toBe(false)
    expect(checkBackupVersion('1.0').ok).toBe(false)
    expect(checkBackupVersion('1.0.x').ok).toBe(false)
  })

  it('validates counts structurally (ARCHIVE_COUNT_MISMATCH)', () => {
    const sum = mutateDoc((doc) => {
      const counts = doc['counts'] as Record<string, number>
      counts['readableAtExport'] = 999
    })
    expect(rejection(parseRecoveryArchive(sum), 'ARCHIVE_COUNT_MISMATCH').message).toContain('+')

    const lengths = mutateDoc((doc) => {
      const counts = doc['counts'] as Record<string, number>
      counts['drugRows'] = 5
    })
    expect(rejection(parseRecoveryArchive(lengths), 'ARCHIVE_COUNT_MISMATCH').message).toContain(
      '5',
    )

    const partial = mutateDoc((doc) => {
      delete (doc['counts'] as Record<string, unknown>)['metaRows']
    })
    rejection(parseRecoveryArchive(partial), 'ARCHIVE_COUNT_MISMATCH')

    const fractional = mutateDoc((doc) => {
      const counts = doc['counts'] as Record<string, number>
      counts['metaRows'] = 1.5
    })
    rejection(parseRecoveryArchive(fractional), 'ARCHIVE_COUNT_MISMATCH')
  })

  it('enforces row limits (ARCHIVE_LIMIT_EXCEEDED)', () => {
    const metaRows = Array.from({ length: MAX_META_ROWS + 1 }, (_, i) => ({
      key: `m${i}`,
      value: { ...META_VALUE, id: `m${i}` },
    }))
    const doc = {
      formatId: 'npsb',
      backupVersion: '1.0.0',
      exportedAt: EXPORTED_AT,
      storage: STORAGE,
      counts: {
        drugRows: 0,
        readableAtExport: 0,
        quarantinedAtExport: 0,
        metaRows: metaRows.length,
      },
      drugs: [],
      meta: metaRows,
    }
    const issue = rejection(parseRecoveryArchive(JSON.stringify(doc)), 'ARCHIVE_LIMIT_EXCEEDED')
    expect(issue.limit).toBe('meta rows')
  })

  it('validates entry shape, key type, key/id agreement and duplicates', () => {
    const notObject = mutateDoc((doc) => {
      ;(doc['drugs'] as unknown[])[0] = 42
    })
    expect(
      rejection(parseRecoveryArchive(notObject), 'ARCHIVE_ENTRY_SHAPE').message,
    ).toContain('must be an object')

    const extraKey = mutateDoc((doc) => {
      ;(doc['drugs'] as Record<string, unknown>[])[0]!['surprise'] = 1
    })
    expect(rejection(parseRecoveryArchive(extraKey), 'ARCHIVE_ENTRY_SHAPE').message).toContain(
      'surprise',
    )

    const missingValue = mutateDoc((doc) => {
      delete (doc['drugs'] as Record<string, unknown>[])[0]!['value']
    })
    rejection(parseRecoveryArchive(missingValue), 'ARCHIVE_ENTRY_SHAPE')

    const numericKey = mutateDoc((doc) => {
      ;(doc['drugs'] as Record<string, unknown>[])[0]!['key'] = 7
    })
    expect(
      rejection(parseRecoveryArchive(numericKey), 'ARCHIVE_KEY_TYPE').valueType,
    ).toBe('number')

    const arrayValue = mutateDoc((doc) => {
      ;(doc['drugs'] as Record<string, unknown>[])[0]!['value'] = [1]
    })
    rejection(parseRecoveryArchive(arrayValue), 'ARCHIVE_ENTRY_SHAPE')

    const idMismatch = mutateDoc((doc) => {
      const entry = (doc['drugs'] as Record<string, unknown>[])[0]!
      ;(entry['value'] as Record<string, unknown>)['id'] = 'someone-else'
    })
    expect(rejection(parseRecoveryArchive(idMismatch), 'ARCHIVE_KEY_MISMATCH').key).toBe(
      'fixture-drug-1',
    )

    const duplicate = mutateDoc((doc) => {
      const drugs = doc['drugs'] as Record<string, unknown>[]
      drugs.push({ ...drugs[0] })
      const counts = doc['counts'] as Record<string, number>
      counts['drugRows'] = 2
      counts['readableAtExport'] = 2
    })
    const issue = rejection(parseRecoveryArchive(duplicate), 'ARCHIVE_DUPLICATE_KEY')
    expect(issue.key).toBe('fixture-drug-1')
    expect(issue.message).toContain('already declared')
  })

  it('validates sidecars end to end (ARCHIVE_ANNOTATION_* / ARCHIVE_VALUE_DOMAIN)', () => {
    const withEntry = (
      value: Record<string, unknown>,
      specialNumbers: unknown,
    ): string =>
      mutateDoc((doc) => {
        const entry = (doc['drugs'] as Record<string, unknown>[])[0]!
        entry['value'] = value
        if (specialNumbers === undefined) delete entry['specialNumbers']
        else entry['specialNumbers'] = specialNumbers
      })

    rejection(
      parseRecoveryArchive(
        withEntry({ id: 'fixture-drug-1', a: null }, [{ path: '/a', kind: 'zero' }]),
      ),
      'ARCHIVE_ANNOTATION_SHAPE',
    )
    rejection(
      parseRecoveryArchive(withEntry({ id: 'fixture-drug-1', a: null }, 'nope')),
      'ARCHIVE_ANNOTATION_SHAPE',
    )
    rejection(
      parseRecoveryArchive(
        withEntry({ id: 'fixture-drug-1', a: null }, [{ path: 'a', kind: 'NaN' }]),
      ),
      'ARCHIVE_ANNOTATION_PATH',
    )
    rejection(
      parseRecoveryArchive(
        withEntry({ id: 'fixture-drug-1', a: null }, [
          { path: '/a', kind: 'NaN' },
          { path: '/a', kind: 'Infinity' },
        ]),
      ),
      'ARCHIVE_ANNOTATION_DUPLICATE',
    )
    // Placeholder must match the kind: /a holds null, kind expects 0.
    rejection(
      parseRecoveryArchive(
        withEntry({ id: 'fixture-drug-1', a: null }, [{ path: '/a', kind: '-0' }]),
      ),
      'ARCHIVE_ANNOTATION_PLACEHOLDER',
    )
    // Unannotated special number (-0 is the only one JSON text can carry).
    // JSON.stringify normalizes -0 to 0, so the literal is injected into
    // the serialized text — exactly the shape an archive must reject.
    const domainText = withEntry({ id: 'fixture-drug-1', z: 0 }, undefined).replace(
      '"z":0',
      '"z":-0',
    )
    expect(domainText).toContain('"z":-0')
    const domain = rejection(parseRecoveryArchive(domainText), 'ARCHIVE_VALUE_DOMAIN')
    expect(domain.path).toBe('/z')

    // And the happy path: an annotation that resolves and materializes.
    const okText = withEntry({ id: 'fixture-drug-1', a: null }, [
      { path: '/a', kind: 'NaN' },
    ])
    const parsed = parseRecoveryArchive(okText)
    if (!parsed.ok) throw new Error(`expected ok: ${JSON.stringify(parsed.issues)}`)
    expect(Number.isNaN(parsed.archive.drugs[0]?.value['a'] as number)).toBe(true)
  })
})

describe('classifyArchiveDrugs and buildRecoveryWarnings (§8.3)', () => {
  it('classifies with this build and reports no warnings for a matching archive', () => {
    const result = buildOk()
    if (!result.ok) throw new Error('unreachable')
    const parsed = parseRecoveryArchive(result.text)
    if (!parsed.ok) throw new Error('unreachable')
    const current = classifyArchiveDrugs(parsed.archive.drugs)
    expect(current).toEqual({ readable: 1, quarantined: 0 })
    expect(buildRecoveryWarnings(parsed.archive, STORAGE, current)).toEqual([])
  })

  it('warns when the archive counts no longer match this build (RECLASSIFICATION_DIFFERS)', () => {
    const doctored = mutateDoc((doc) => {
      const counts = doc['counts'] as Record<string, number>
      counts['readableAtExport'] = 0
      counts['quarantinedAtExport'] = 1
    })
    const parsed = parseRecoveryArchive(doctored)
    if (!parsed.ok) throw new Error('unreachable')
    const current = classifyArchiveDrugs(parsed.archive.drugs)
    const warnings = buildRecoveryWarnings(parsed.archive, STORAGE, current)
    expect(warnings.map((warning) => warning.code)).toContain('RECLASSIFICATION_DIFFERS')
  })

  it('warns on storage version differences (STORAGE_VERSION_DIFFERS)', () => {
    const result = buildOk()
    if (!result.ok) throw new Error('unreachable')
    const parsed = parseRecoveryArchive(result.text)
    if (!parsed.ok) throw new Error('unreachable')
    const current = classifyArchiveDrugs(parsed.archive.drugs)
    const warnings = buildRecoveryWarnings(
      parsed.archive,
      { databaseVersion: 3, persistenceVersion: 99 },
      current,
    )
    expect(warnings.map((warning) => warning.code)).toContain('STORAGE_VERSION_DIFFERS')
    expect(warnings[0]?.message).toContain('no migration is applied by restore')
  })

  it('warns on metadata this build cannot read and on an empty archive', () => {
    const unreadableMeta = buildOk({
      meta: [{ key: 'local-library', value: { id: 'local-library' } }],
    })
    if (!unreadableMeta.ok) throw new Error('unreachable')
    const parsedUnreadable = parseRecoveryArchive(unreadableMeta.text)
    if (!parsedUnreadable.ok) throw new Error('unreachable')
    const warningsUnreadable = buildRecoveryWarnings(
      parsedUnreadable.archive,
      STORAGE,
      classifyArchiveDrugs(parsedUnreadable.archive.drugs),
    )
    expect(warningsUnreadable.map((warning) => warning.code)).toContain(
      'ARCHIVE_META_UNREADABLE',
    )

    const empty = buildOk({ drugs: [], meta: [] })
    if (!empty.ok) throw new Error('unreachable')
    const parsedEmpty = parseRecoveryArchive(empty.text)
    if (!parsedEmpty.ok) throw new Error('unreachable')
    const warningsEmpty = buildRecoveryWarnings(
      parsedEmpty.archive,
      STORAGE,
      classifyArchiveDrugs(parsedEmpty.archive.drugs),
    )
    expect(warningsEmpty.map((warning) => warning.code)).toContain('ARCHIVE_EMPTY')
    expect(warningsEmpty.find((warning) => warning.code === 'ARCHIVE_EMPTY')?.message).toContain(
      'empties the library',
    )
  })
})
