import { expect, test, type Page } from '@playwright/test'

/**
 * NV-2 evidence upgrade (phase 23): the application's historical IndexedDB
 * schema migrations exercised inside REAL Chromium, against synthetic
 * legacy databases created with the raw IndexedDB API from the verified
 * historical schema definitions (git history: v1/v2 from b178c0d, v3 from
 * 5146264, v4 from de95c95 — see docs/testing.md §4.13).
 *
 * What this proves: Chromium's own versioned-upgrade engine, driven by the
 * current application's Dexie schema declarations, upgrades databases
 * written by v1/v2/v3 builds in place — only the documented bookkeeping
 * backfill (v1→v2) runs, additive stores appear empty, and every
 * scientific value, provenance object and unknown (future) field survives
 * byte-identically, across close/reopen as well.
 *
 * Native version numbers (verified from dexie@4.4.6 — the same version
 * every historical build used — in node_modules/dexie/dist/dexie.mjs):
 * Dexie opens IndexedDB at `declared × 10` (`nativeVerToOpen = Math.round(db.verno * 10)`)
 * and normalizes the incoming version back with `runUpgraders(db, oldVer / 10, …)`.
 * A build that declared schema version N therefore wrote native version
 * 10·N: 10 for the v1 declaration, 20 for the v2-era builds (phase 3–17),
 * 30 for the v3-era builds (phase 18–19), and the current v4 build opens
 * at native 40. Seeding at 1/2/3 would fabricate version numbers no build
 * of this application ever produced, so these tests seed at the authentic
 * native versions; the seeded-then-upgraded chains below therefore run
 * with exactly the declared-version semantics the unit tests model.
 *
 * What this does NOT prove (audit NV-2 stays open): these are SYNTHETIC
 * legacy rows built from the historical schema contract. No authentic
 * legacy user database was or is available; nothing here inspects real
 * user data, and none is fabricated to look real.
 *
 * Isolation/determinism: every test runs in its own browser context (its
 * own storage partition), seeds the shared database name at a historical
 * version through a same-origin intercepted page that never loads the app
 * bundle, closes every seeding connection, and only then navigates to the
 * real app. No fixed sleeps — seeding is awaited via transaction
 * completion, the seed page reports readiness in the DOM, and hydration is
 * asserted with bounded Playwright waits. An IndexedDB database cannot be
 * downgraded, so each scenario seeds BEFORE the app ever opens the name.
 *
 * Every fixture value is unmistakably synthetic test data.
 */

const DB_NAME = 'neuropharmacology-sandbox'
const SEED_PATH = '/seed-migration.html'

/**
 * Hydration budget for a cold dev-server first compile plus the real
 * versionchange upgrade: a bounded Playwright wait, never a sleep — the
 * same assertions would still fail if the chain were broken.
 */
const HYDRATE_TIMEOUT = 20_000

/** The backfilled stamp is `new Date().toISOString()` — ms precision + Z. */
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// Generous but bounded per-test budget (cold Vite compile + real upgrade +
// hydration + reopen re-hydration). File-scope default for this spec only.
test.setTimeout(90_000)

/* ------------------------------------------------------------------ */
/* Historical schema store specs (verified against git history)        */
/* ------------------------------------------------------------------ */

/**
 * Native IndexedDB version = declared Dexie version × 10 (see header).
 * A database seeded at NATIVE_Vn has exactly the schema a build
 * declaring version(n) wrote.
 */
const NATIVE_V1 = 10
const NATIVE_V2 = 20
const NATIVE_V3 = 30
/** Native encoding of the current application schema (declared v4). */
const NATIVE_V4 = 40

interface SeedIndexSpec {
  name: string
  keyPath: string
}
interface SeedStoreSpec {
  name: string
  keyPath: string
  indexes?: SeedIndexSpec[]
}
interface SeedConfig {
  name: string
  version: number
  stores: SeedStoreSpec[]
  rows: Record<string, unknown[]>
}

/** v1 (b178c0d): `drugs` keyed by `id`, `meta` keyed by `id`. */
const STORES_V1: SeedStoreSpec[] = [
  { name: 'drugs', keyPath: 'id' },
  { name: 'meta', keyPath: 'id' },
]

/** v2 (b178c0d): adds the `origin` and `updatedAt` drug indexes. */
const STORES_V2: SeedStoreSpec[] = [
  {
    name: 'drugs',
    keyPath: 'id',
    indexes: [
      { name: 'origin', keyPath: 'origin' },
      { name: 'updatedAt', keyPath: 'updatedAt' },
    ],
  },
  { name: 'meta', keyPath: 'id' },
]

/** v3 (5146264): adds `compounds` and `observations` (+ `compoundId`). */
const STORES_V3: SeedStoreSpec[] = [
  ...STORES_V2,
  { name: 'compounds', keyPath: 'id' },
  {
    name: 'observations',
    keyPath: 'id',
    indexes: [{ name: 'compoundId', keyPath: 'compoundId' }],
  },
]

/** The current v4 schema the app must reach (de95c95). */
const EXPECTED_V4_STORES = {
  drugs: ['origin', 'updatedAt'],
  meta: [],
  compounds: [],
  observations: ['compoundId'],
  revisions: [],
}

/* ------------------------------------------------------------------ */
/* Synthetic fixtures — never pharmacological information              */
/* ------------------------------------------------------------------ */

const NV23_NOTE = 'Synthetic NV-23 migration fixture — not pharmacological information.'

/** Root-level unknown (future) fields at several nesting levels. */
function withUnknownFields(base: Record<string, unknown>): Record<string, unknown> {
  const targets = base['targets'] as Record<string, unknown>[] | undefined
  return {
    ...base,
    nv23FutureRoot: { note: NV23_NOTE, level: 1 },
    identifiers: {
      ...(base['identifiers'] as Record<string, unknown>),
      nv23FutureIdentifiers: 'synthetic-identifiers-extension',
    },
    pharmacokinetics: {
      ...(base['pharmacokinetics'] as Record<string, unknown>),
      nv23FuturePk: true,
    },
    ...(targets !== undefined
      ? {
          targets: targets.map((t, i) => {
            if (i !== 0) return t
            const paramKey = ['kd', 'ki', 'ec50', 'ic50'].find((k) => t[k] !== undefined)
            const param = paramKey !== undefined ? (t[paramKey] as Record<string, unknown>) : undefined
            return {
              ...t,
              nv23FutureTarget: ['synthetic', 'target', 'extension'],
              ...(paramKey !== undefined && param !== undefined
                ? {
                    [paramKey]: {
                      ...param,
                      provenance: {
                        ...(param['provenance'] as Record<string, unknown>),
                        nv23FutureProvenance: 'synthetic-provenance-extension',
                      },
                    },
                  }
                : {}),
            }
          }),
        }
      : {}),
  }
}

const META_ROW: Record<string, unknown> = {
  id: 'local-library',
  name: 'NV23 Synthetic Migration Library',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  dataStatus: 'user',
}

/** v1 row A: no persistenceVersion, NO timestamps — full backfill case. */
const V1_ALPHA = withUnknownFields({
  id: 'nv23-v1-alpha',
  origin: 'user',
  identifiers: {
    name: 'NV23 Synthetic Legacy Alpha',
    synonyms: ['NV23-A'],
    description: NV23_NOTE,
  },
  tags: ['synthetic', 'nv23'],
  targets: [
    {
      id: 'nv23-target-alpha',
      name: 'NV23 Synthetic Target Alpha',
      gene: 'NV23A',
      action: 'agonist',
      species: 'synthetic species',
      notes: NV23_NOTE,
      kd: {
        value: 4.2,
        unit: 'nM',
        provenance: {
          type: 'literature',
          source: 'NV23 synthetic source',
          citation: 'NV23 synthetic citation',
          doi: '10.000000/nv23.synthetic',
        },
      },
      ki: {
        value: 7.7,
        unit: 'nM',
        provenance: { type: 'user', recordedAt: '2025-02-01T00:00:00.000Z' },
      },
    },
  ],
  pharmacokinetics: {
    halfLife: {
      value: 3.5,
      unit: 'h',
      provenance: { type: 'unknown', notes: NV23_NOTE },
    },
  },
  notes: NV23_NOTE,
})

/** v1 row B: complete bookkeeping — must remain byte-identical. */
const V1_BETA = withUnknownFields({
  id: 'nv23-v1-beta',
  origin: 'user',
  identifiers: { name: 'NV23 Synthetic Legacy Beta', synonyms: [] },
  tags: ['synthetic'],
  targets: [
    {
      id: 'nv23-target-beta',
      name: 'NV23 Synthetic Target Beta',
      kd: {
        value: 1.25,
        unit: 'µM',
        provenance: { type: 'calculated', model: 'nv23-synthetic-model' },
      },
    },
  ],
  pharmacokinetics: {},
  persistenceVersion: 2,
  createdAt: '2025-03-01T10:00:00.000Z',
  updatedAt: '2025-03-02T11:00:00.000Z',
})

/** v1 row C: createdAt only — updatedAt must be backfilled FROM it. */
const V1_GAMMA = withUnknownFields({
  id: 'nv23-v1-gamma',
  origin: 'user',
  identifiers: { name: 'NV23 Synthetic Legacy Gamma', synonyms: [] },
  tags: [],
  targets: [],
  pharmacokinetics: {},
  createdAt: '2025-04-05T06:07:08.000Z',
})

const V2_DELTA = withUnknownFields({
  id: 'nv23-v2-delta',
  origin: 'user',
  identifiers: { name: 'NV23 Synthetic V2 Delta', synonyms: ['NV23-D'] },
  tags: ['synthetic'],
  targets: [
    {
      id: 'nv23-target-delta',
      name: 'NV23 Synthetic Target Delta',
      ec50: {
        value: 2.5e-9,
        unit: 'M',
        provenance: {
          type: 'derived',
          method: 'nv23 synthetic derivation',
          from: ['kd'],
        },
      },
    },
  ],
  pharmacokinetics: {},
  persistenceVersion: 2,
  createdAt: '2025-05-01T00:00:00.000Z',
  updatedAt: '2025-05-02T00:00:00.000Z',
})

const V2_EPSILON = withUnknownFields({
  id: 'nv23-v2-epsilon',
  origin: 'imported',
  identifiers: { name: 'NV23 Synthetic V2 Epsilon', synonyms: [] },
  tags: [],
  targets: [
    {
      id: 'nv23-target-epsilon',
      name: 'NV23 Synthetic Target Epsilon',
      ic50: {
        value: 88.8,
        unit: 'nM',
        provenance: { type: 'user', recordedAt: '2025-05-03T00:00:00.000Z' },
      },
    },
  ],
  pharmacokinetics: {
    notes: NV23_NOTE,
  },
  notes: NV23_NOTE,
  // Tripwire: bookkeeping deliberately left incomplete, as a foreign
  // writer would leave it. If the v1→v2 backfill hook were to fire on this
  // already-v2 database, it would add `persistenceVersion` and stamp
  // `updatedAt` from `createdAt` — and the whole-row byte-identity
  // assertion in the v2 test would fail. Complete rows alone could not
  // detect a spuriously-firing (no-op) hook.
  createdAt: '2025-05-03T00:00:00.000Z',
})

const V3_ZETA = withUnknownFields({
  id: 'nv23-v3-zeta',
  origin: 'user',
  identifiers: { name: 'NV23 Synthetic V3 Zeta', synonyms: [] },
  tags: ['synthetic'],
  targets: [
    {
      id: 'nv23-target-zeta',
      name: 'NV23 Synthetic Target Zeta',
      species: 'synthetic species',
      kd: {
        value: 0.5,
        unit: 'nM',
        provenance: { type: 'unknown' },
      },
    },
  ],
  pharmacokinetics: {},
  // Tripwire (same rationale as V2_EPSILON): proves the additive v3→v4
  // upgrade runs no bookkeeping backfill on existing drug rows either.
  createdAt: '2025-06-01T00:00:00.000Z',
})

const NV23_ATTRIBUTION = {
  source: 'nv23-synthetic',
  sourceName: 'NV23 synthetic source registry',
  recordId: 'NV23-SYNTHETIC',
  url: 'https://example.invalid/nv23-synthetic',
  retrievedAt: '2025-06-01T00:00:00.000Z',
}

/** A v3-era Layer-A marker row (current-schema-valid, synthetic). */
const V3_COMPOUND: Record<string, unknown> = {
  id: 'nv23-synthetic:NV23C1',
  source: 'nv23-synthetic',
  sourceId: 'NV23C1',
  name: 'NV23 Synthetic Compound',
  synonyms: [],
  identifiers: {},
  provenance: NV23_ATTRIBUTION,
  createdAt: '2025-06-01T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
}

/** A v3-era Layer-B marker row (current-schema-valid, synthetic). */
const V3_OBSERVATION: Record<string, unknown> = {
  id: 'nv23-synthetic:NV23O1',
  compoundId: 'nv23-synthetic:NV23C1',
  compoundSourceId: 'NV23C1',
  compoundName: 'NV23 Synthetic Compound',
  target: { name: 'NV23 Synthetic Target Zeta' },
  endpoint: 'NV23 synthetic endpoint',
  value: 6.6,
  unit: 'nM',
  provenance: NV23_ATTRIBUTION,
  createdAt: '2025-06-01T00:00:00.000Z',
  updatedAt: '2025-06-01T00:00:00.000Z',
}

/* ------------------------------------------------------------------ */
/* Browser helpers                                                     */
/* ------------------------------------------------------------------ */

interface RawSnapshot {
  version: number
  stores: Record<string, string[]>
  rows: Record<string, unknown[]>
}

const SEED_PAGE_SCRIPT = `
  const cfg = JSON.parse(document.getElementById('seed-data').textContent);
  const done = (text) => { document.getElementById('seed-status').textContent = text; };
  const openReq = indexedDB.open(cfg.name, cfg.version);
  openReq.onupgradeneeded = () => {
    const db = openReq.result;
    for (const spec of cfg.stores) {
      if (db.objectStoreNames.contains(spec.name)) continue;
      const store = db.createObjectStore(spec.name, { keyPath: spec.keyPath });
      for (const idx of (spec.indexes || [])) store.createIndex(idx.name, idx.keyPath);
    }
  };
  openReq.onerror = () => done('error: ' + openReq.error);
  openReq.onsuccess = () => {
    const db = openReq.result;
    const storeNames = Object.keys(cfg.rows);
    if (storeNames.length === 0) { db.close(); done('done'); return; }
    const tx = db.transaction(storeNames, 'readwrite');
    for (const storeName of storeNames) {
      const store = tx.objectStore(storeName);
      for (const row of cfg.rows[storeName]) store.put(row);
    }
    tx.onabort = () => done('error: ' + tx.error);
    tx.oncomplete = () => { db.close(); done('done'); };
  };
`

/** Serve a same-origin document that ONLY seeds IndexedDB — no app bundle. */
async function seedHistoricalDatabase(page: Page, config: SeedConfig): Promise<void> {
  const seedJson = JSON.stringify(config).replace(/</g, '\\u003c')
  const html = [
    '<!doctype html>',
    '<meta charset="utf-8" />',
    '<title>NV23 historical database seed</title>',
    '<div id="seed-status">running</div>',
    `<script type="application/json" id="seed-data">${seedJson}<` + '/script>',
    `<script>${SEED_PAGE_SCRIPT}<` + '/script>',
  ].join('\n')
  await page.route(`**${SEED_PATH}`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }),
  )
  await page.goto(SEED_PATH)
  // Seeding is complete only when the transaction chain finished and the
  // page closed its connection — reported in the DOM, never a sleep.
  await expect(page.locator('#seed-status')).toHaveText('done', { timeout: HYDRATE_TIMEOUT })
}

/**
 * Direct raw-IndexedDB read (no Dexie, no app code): version, per-store
 * index names and every row, structured-cloned out of the browser.
 */
async function rawSnapshot(page: Page, name: string): Promise<RawSnapshot> {
  return page.evaluate(async (dbName) => {
    const db: IDBDatabase = await new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName)
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
    const stores: Record<string, string[]> = {}
    const rows: Record<string, unknown[]> = {}
    const names = Array.from(db.objectStoreNames)
    const tx = db.transaction(names, 'readonly')
    for (const storeName of names) {
      const store = tx.objectStore(storeName)
      stores[storeName] = Array.from(store.indexNames)
      rows[storeName] = await new Promise((resolve, reject) => {
        const req = store.getAll()
        req.onsuccess = () => resolve(req.result as unknown[])
        req.onerror = () => reject(req.error)
      })
    }
    db.close()
    return { version: db.version, stores, rows }
  }, name)
}

/** Hydration assertions visible to a user; nothing silently dropped. */
async function expectHydrated(page: Page, names: string[]): Promise<void> {
  await expect(page.getByTestId('drug-list')).toBeVisible({ timeout: HYDRATE_TIMEOUT })
  for (const name of names) {
    await expect(page.getByText(name, { exact: true })).toBeVisible({ timeout: HYDRATE_TIMEOUT })
  }
  await expect(page.getByTestId('library-count')).toContainText(
    `${names.length} of ${names.length} record`,
    { timeout: HYDRATE_TIMEOUT },
  )
  await expect(page.getByTestId('quarantine-banner')).toBeHidden()
  await expect(page.getByTestId('library-error')).toBeHidden()
}

function findRow(rows: unknown[], id: string): Record<string, unknown> {
  const row = rows.find((r) => (r as Record<string, unknown>)['id'] === id)
  if (row === undefined) throw new Error(`expected row "${id}" in the raw snapshot`)
  return row as Record<string, unknown>
}

function omitKeys(row: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...row }
  for (const key of keys) delete copy[key]
  return copy
}

/* ------------------------------------------------------------------ */
/* Scenarios                                                           */
/* ------------------------------------------------------------------ */

test('v1 database upgrades to v4 in real Chromium: bookkeeping backfill only, science and unknown fields byte-identical', async ({
  page,
}) => {
  const config: SeedConfig = {
    name: DB_NAME,
    // Native 10 ⇔ a build declaring schema version 1 (v1 store layout).
    version: NATIVE_V1,
    stores: STORES_V1,
    rows: { drugs: [V1_ALPHA, V1_BETA, V1_GAMMA], meta: [META_ROW] },
  }
  await seedHistoricalDatabase(page, config)

  // (1) The seeded database really is at the historical version/schema.
  const seeded = await rawSnapshot(page, DB_NAME)
  expect(seeded.version).toBe(NATIVE_V1)
  expect(seeded.stores).toEqual({ drugs: [], meta: [] })

  // (2) The current application opens the SAME database and migrates it.
  await page.goto('/library')
  await expectHydrated(page, [
    'NV23 Synthetic Legacy Alpha',
    'NV23 Synthetic Legacy Beta',
    'NV23 Synthetic Legacy Gamma',
  ])

  // (3) Storage-level assertions from the real browser database.
  const migrated = await rawSnapshot(page, DB_NAME)
  // The app opened the database at its current schema: declared version 4
  // ⇔ native 40 (Dexie ×10 — see header). Any other declared version
  // would yield a different native number; the store set asserted next is
  // the semantic content of schema version 4.
  expect(migrated.version).toBe(NATIVE_V4)
  expect(migrated.stores).toEqual(EXPECTED_V4_STORES)

  // Row A: only the documented keys are added; everything else identical.
  const alpha = findRow(migrated.rows['drugs']!, 'nv23-v1-alpha')
  const alphaPre = findRow(seeded.rows['drugs']!, 'nv23-v1-alpha')
  expect(omitKeys(alpha, ['persistenceVersion', 'createdAt', 'updatedAt'])).toEqual(alphaPre)
  expect(alpha['persistenceVersion']).toBe(2)
  // Both timestamps were missing: the hook generates ONE stamp for both.
  expect(alpha['createdAt']).toMatch(ISO_STAMP)
  expect(alpha['updatedAt']).toBe(alpha['createdAt'])

  // Row B: fully backfilled already — the whole row is untouched.
  expect(findRow(migrated.rows['drugs']!, 'nv23-v1-beta')).toEqual(
    findRow(seeded.rows['drugs']!, 'nv23-v1-beta'),
  )

  // Row C: createdAt preserved exactly; updatedAt backfilled FROM it.
  const gamma = findRow(migrated.rows['drugs']!, 'nv23-v1-gamma')
  const gammaPre = findRow(seeded.rows['drugs']!, 'nv23-v1-gamma')
  expect(omitKeys(gamma, ['persistenceVersion', 'updatedAt'])).toEqual(gammaPre)
  expect(gamma['persistenceVersion']).toBe(2)
  expect(gamma['createdAt']).toBe('2025-04-05T06:07:08.000Z')
  expect(gamma['updatedAt']).toBe('2025-04-05T06:07:08.000Z')

  // Metadata untouched; additive stores exist and are empty (never seeded).
  expect(migrated.rows['meta']).toEqual(seeded.rows['meta'])
  expect(migrated.rows['compounds']).toEqual([])
  expect(migrated.rows['observations']).toEqual([])
  expect(migrated.rows['revisions']).toEqual([])

  // (4) Reopen: a fresh page load + a fresh raw connection cause no further
  // mutation (the upgrade is idempotent at v4).
  await page.goto('/library')
  await expectHydrated(page, [
    'NV23 Synthetic Legacy Alpha',
    'NV23 Synthetic Legacy Beta',
    'NV23 Synthetic Legacy Gamma',
  ])
  expect(await rawSnapshot(page, DB_NAME)).toEqual(migrated)
})

test('v2 database upgrades to v4 in real Chromium: stored rows byte-identical, no spurious backfill', async ({
  page,
}) => {
  const config: SeedConfig = {
    name: DB_NAME,
    // Native 20 ⇔ the v2-era builds (phase 3–17 declared version(1)+version(2)).
    version: NATIVE_V2,
    stores: STORES_V2,
    rows: { drugs: [V2_DELTA, V2_EPSILON], meta: [META_ROW] },
  }
  await seedHistoricalDatabase(page, config)

  const seeded = await rawSnapshot(page, DB_NAME)
  expect(seeded.version).toBe(NATIVE_V2)
  expect(seeded.stores).toEqual({ drugs: ['origin', 'updatedAt'], meta: [] })

  await page.goto('/library')
  await expectHydrated(page, ['NV23 Synthetic V2 Delta', 'NV23 Synthetic V2 Epsilon'])

  const migrated = await rawSnapshot(page, DB_NAME)
  // The app opened the database at its current schema: declared version 4
  // ⇔ native 40 (Dexie ×10 — see header). Any other declared version
  // would yield a different native number; the store set asserted next is
  // the semantic content of schema version 4.
  expect(migrated.version).toBe(NATIVE_V4)
  expect(migrated.stores).toEqual(EXPECTED_V4_STORES)

  // The v1→v2 backfill must NOT run on an already-v2 database: every row
  // is byte-identical — and V2_EPSILON (missing persistenceVersion and
  // updatedAt) is the tripwire that would reveal a spuriously-firing hook,
  // which would have rewritten it.
  expect(migrated.rows['drugs']).toEqual(seeded.rows['drugs'])
  expect(migrated.rows['meta']).toEqual(seeded.rows['meta'])
  expect(migrated.rows['compounds']).toEqual([])
  expect(migrated.rows['observations']).toEqual([])
  expect(migrated.rows['revisions']).toEqual([])

  await page.goto('/library')
  await expectHydrated(page, ['NV23 Synthetic V2 Delta', 'NV23 Synthetic V2 Epsilon'])
  expect(await rawSnapshot(page, DB_NAME)).toEqual(migrated)
})

test('v3 database upgrades to v4 in real Chromium: source-data rows preserved, revisions added empty', async ({
  page,
}) => {
  const config: SeedConfig = {
    name: DB_NAME,
    // Native 30 ⇔ the v3-era builds (phase 18–19 declared through version(3)).
    version: NATIVE_V3,
    stores: STORES_V3,
    rows: {
      drugs: [V3_ZETA],
      meta: [META_ROW],
      compounds: [V3_COMPOUND],
      observations: [V3_OBSERVATION],
    },
  }
  await seedHistoricalDatabase(page, config)

  const seeded = await rawSnapshot(page, DB_NAME)
  expect(seeded.version).toBe(NATIVE_V3)
  expect(seeded.stores).toEqual({
    drugs: ['origin', 'updatedAt'],
    meta: [],
    compounds: [],
    observations: ['compoundId'],
  })

  await page.goto('/library')
  await expectHydrated(page, ['NV23 Synthetic V3 Zeta'])

  const migrated = await rawSnapshot(page, DB_NAME)
  // The app opened the database at its current schema: declared version 4
  // ⇔ native 40 (Dexie ×10 — see header). Any other declared version
  // would yield a different native number; the store set asserted next is
  // the semantic content of schema version 4.
  expect(migrated.version).toBe(NATIVE_V4)
  expect(migrated.stores).toEqual(EXPECTED_V4_STORES)

  // Every pre-existing store is byte-identical — no drug row is rewritten
  // merely because the revisions table was added.
  expect(migrated.rows['drugs']).toEqual(seeded.rows['drugs'])
  expect(migrated.rows['meta']).toEqual(seeded.rows['meta'])
  expect(migrated.rows['compounds']).toEqual(seeded.rows['compounds'])
  expect(migrated.rows['observations']).toEqual(seeded.rows['observations'])
  // The only change is the new, empty revisions store (existing records
  // read as revision 0 until their first write — no rows invented).
  expect(migrated.rows['revisions']).toEqual([])

  await page.goto('/library')
  await expectHydrated(page, ['NV23 Synthetic V3 Zeta'])
  expect(await rawSnapshot(page, DB_NAME)).toEqual(migrated)
})
