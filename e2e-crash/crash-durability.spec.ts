import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, expect, test, type Browser, type Page } from '@playwright/test'

/**
 * NV-1 real-browser crash durability (phase 21, audit data-integrity-audit.md).
 *
 * Question tested: when the browser PROCESS is terminated from the
 * outside while the production `.npsb` restore transaction
 * (`restoreRecoveryArchive`: one `rw` transaction over drugs+meta+
 * revisions doing clear → put → per-id revision bump) is genuinely in
 * flight — at least one mutation applied, commit not reached — does
 * IndexedDB atomicity hold across the restart? The same harness runs a
 * positive control: a restore that COMMITTED, followed by the same
 * external process kill, must survive restart completely.
 *
 * Harness (test-only instrumentation, no production failpoints):
 * - Each browser is a supervised OS child of the test process with a
 *   dedicated disposable `--user-data-dir`; the test drives it over CDP
 *   (`chromium.connectOverCDP`) and kills the process TREE externally
 *   (`taskkill /T /F` on Windows, SIGKILL to the detached group on
 *   POSIX). A page reload, tab close, graceful shutdown or
 *   `transaction.abort()` is NOT used and would not count.
 * - A test-owned local HTTP server is the only channel out of the
 *   renderer. In crash mode, instrumentation
 *   (`IDBObjectStore.prototype.clear/put` wrappers installed with
 *   `addInitScript`) marks the transaction that clears the `drugs`
 *   store — the restore's signature — and on its SECOND completed drug
 *   `put` sends a SYNCHRONOUS XMLHttpRequest to the server and never
 *   returns (the server withholds the response), holding the real
 *   transaction open and uncommitted while the supervisor kills the
 *   process. The server's receipt of the payload
 *   `{mode, store, op, clearSeen, putsInTx}` is the observable proof
 *   the transaction reached exactly that checkpoint.
 * - After the kill, the same profile is relaunched in a fresh Chromium
 *   process and the database is compared against a RAW pre-crash
 *   snapshot (direct `indexedDB.open` reads of drugs/meta/revisions —
 *   byte-level truth including unknown fields, provenance, source
 *   references) plus UI hydration assertions.
 *
 * Determinism: no fixed sleeps anywhere — event-driven synchronization
 * only (HTTP receipt, child `exit` event, Playwright auto-waiting
 * assertions) with bounded watchdogs. Every value is synthetic test
 * data; no external request is made.
 *
 * Scope honesty: this proves process-crash durability for the restore
 * transaction. It does NOT prove hardware power loss, OS/kernel crash,
 * physical disk failure or storage-controller failure.
 */

const APP_URL = 'http://localhost:4173'

const R1_ID = 'nv1-r1'
const R2_ID = 'nv1-r2'
const R3_ID = 'nv1-r3'
const R4_ID = 'nv1-r4'
const R5_ID = 'nv1-r5'

/* ------------------------------------------------------------------ *
 * Synthetic fixtures (old library = the pre-crash persisted state).
 * ------------------------------------------------------------------ */

/** Old-library R1: unknown extension field, provenance, source refs. */
const OLD_R1 = {
  id: R1_ID,
  origin: 'user',
  identifiers: { name: 'NV1 Old Compound Alpha', synonyms: ['NOC-A'] },
  tags: ['synthetic-fixture'],
  targets: [
    {
      id: 'nv1r1',
      name: 'NV1R1',
      kd: {
        value: 4.2,
        unit: 'nM',
        provenance: {
          type: 'literature',
          source: 'Synthetic NV1 source',
          citation: 'Invented for tests, 2026',
        },
      },
      sourceReferences: [
        { source: 'chembl', sourceName: 'ChEMBL', sourceTargetId: 'CHEMBL99992001' },
      ],
    },
  ],
  pharmacokinetics: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  xNv1Extension: 'old-library-extension-marker',
}

const OLD_R2 = {
  id: R2_ID,
  origin: 'user',
  identifiers: { name: 'NV1 Old Compound Beta', synonyms: [] },
  tags: ['synthetic-fixture'],
  targets: [],
  pharmacokinetics: {},
  createdAt: '2026-01-02T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  xNv1Extension: 'beta-extension-marker',
}

/**
 * Old-library R3: a raw-seeded row (the sanctioned narrow raw touch,
 * same pattern as e2e/recovery.spec.ts) carrying unknown future fields
 * an import would never create. Present only in the old library — the
 * restore would remove it — so a surviving partial replacement would be
 * instantly distinguishable.
 */
const RAW_R3 = {
  id: R3_ID,
  origin: 'user',
  persistenceVersion: 2,
  identifiers: { name: 'NV1 Raw-Seeded Gamma', synonyms: [] },
  tags: ['synthetic-fixture'],
  targets: [
    {
      id: 'nv1r3',
      name: 'NV1R3',
      kd: {
        value: 7.7,
        unit: 'nM',
        provenance: {
          type: 'literature',
          source: 'Synthetic NV1 source',
          citation: 'Invented for tests, 2026',
        },
      },
      sourceReferences: [
        { source: 'chembl', sourceName: 'ChEMBL', sourceTargetId: 'CHEMBL99992003' },
      ],
    },
  ],
  pharmacokinetics: {},
  createdAt: '2026-01-03T00:00:00.000Z',
  updatedAt: '2026-01-03T00:00:00.000Z',
  xNv1Extension: 'raw-row-extension-marker',
  nv1FutureField: { nested: 'kept-verbatim' },
}

/** Old-library NPSL import (merge mode; never touches metadata). */
const OLD_NPSL = JSON.stringify({
  formatVersion: '1.0.0',
  schemaVersion: '1.0.0',
  libraryMetadata: {
    id: 'nv1-import',
    name: 'NV1 Ignored Import Metadata',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    dataStatus: 'example',
  },
  drugs: [OLD_R1, OLD_R2],
})

/* ------------------------------------------------------------------ *
 * Archive-library fixtures (the restore target; built in its own
 * disposable profile and exported through the real Recovery UI).
 * ------------------------------------------------------------------ */

/** Archive R1: same id, CHANGED science + changed extension marker. */
const ARCHIVE_R1 = {
  id: R1_ID,
  origin: 'user',
  identifiers: { name: 'NV1 Restored Alpha', synonyms: [] },
  tags: ['synthetic-fixture', 'restored'],
  targets: [
    {
      id: 'nv1r1',
      name: 'NV1R1-R',
      kd: {
        value: 88.8,
        unit: 'nM',
        provenance: {
          type: 'literature',
          source: 'Synthetic NV1 archive source',
          citation: 'Invented for tests, 2026',
        },
      },
      sourceReferences: [
        { source: 'chembl', sourceName: 'ChEMBL', sourceTargetId: 'CHEMBL99992009' },
      ],
    },
  ],
  pharmacokinetics: {},
  createdAt: '2026-02-01T00:00:00.000Z',
  updatedAt: '2026-02-01T00:00:00.000Z',
  xNv1Extension: 'restored-extension-marker',
  xNv1NewField: 'only-in-archive',
}

const ARCHIVE_R2 = {
  id: R2_ID,
  origin: 'user',
  identifiers: { name: 'NV1 Restored Beta', synonyms: [] },
  tags: ['synthetic-fixture', 'restored'],
  targets: [],
  pharmacokinetics: {},
  createdAt: '2026-02-02T00:00:00.000Z',
  updatedAt: '2026-02-02T00:00:00.000Z',
  xNv1Extension: 'restored-beta-marker',
}

/** Archive R4: the added record (absent from the old library). */
const ARCHIVE_R4 = {
  id: R4_ID,
  origin: 'user',
  identifiers: { name: 'NV1 Restored Delta', synonyms: [] },
  tags: ['synthetic-fixture'],
  targets: [],
  pharmacokinetics: {},
  createdAt: '2026-02-04T00:00:00.000Z',
  updatedAt: '2026-02-04T00:00:00.000Z',
}

/** Archive NPSL (replace import — the only way metadata adopts a file). */
function archiveNpsl(negZeroRow: Record<string, unknown>): string {
  return JSON.stringify({
    formatVersion: '1.0.0',
    schemaVersion: '1.0.0',
    libraryMetadata: {
      id: 'nv1-archive-lib',
      name: 'NV1 Archive Library',
      createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-02T00:00:00.000Z',
      dataStatus: 'example',
    },
    drugs: [ARCHIVE_R1, ARCHIVE_R2, ARCHIVE_R4, negZeroRow],
  })
}

/* ------------------------------------------------------------------ *
 * Checkpoint server — the only channel out of the stalled renderer.
 * ------------------------------------------------------------------ */

interface CheckpointEvidence {
  readonly mode: string
  readonly store: string
  readonly op: string
  readonly clearSeen: number
  readonly putsInTx: number
}

interface CheckpointServer {
  readonly url: string
  evidence(timeoutMs: number): Promise<CheckpointEvidence>
  close(): Promise<void>
}

function startCheckpointServer(): Promise<CheckpointServer> {
  return new Promise((resolve, reject) => {
    let deliver: ((evidence: CheckpointEvidence) => void) | undefined
    const firstEvidence = new Promise<CheckpointEvidence>((res) => {
      deliver = res
    })
    const sockets = new Set<import('node:net').Socket>()
    const server = createServer((req, res) => {
      if (req.method === 'OPTIONS') {
        // CORS preflight support; crash-mode sync XHR sends a simple
        // POST and never needs the response anyway.
        res.writeHead(204, {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
        })
        res.end()
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(404)
        res.end()
        return
      }
      let body = ''
      req.setEncoding('utf8')
      req.on('data', (chunk: string) => {
        body += chunk
      })
      req.on('end', () => {
        const evidence = JSON.parse(body) as CheckpointEvidence
        deliver?.(evidence)
        // Deliberately NO response in crash mode: the synchronous XHR
        // must keep blocking the renderer's main thread inside the
        // transaction dispatch until the process is killed.
      })
    })
    server.on('connection', (socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('checkpoint server bound to an unexpected address'))
        return
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/nv1-checkpoint`,
        evidence(timeoutMs: number) {
          return new Promise<CheckpointEvidence>((res, rej) => {
            const timer = setTimeout(
              () =>
                rej(
                  new Error(
                    `no crash checkpoint reached within ${timeoutMs} ms — the restore transaction never hit put #2 after drugs.clear()`,
                  ),
                ),
              timeoutMs,
            )
            firstEvidence.then((value) => {
              clearTimeout(timer)
              res(value)
            })
          })
        },
        async close() {
          for (const socket of sockets) socket.destroy()
          await new Promise<void>((res) => {
            server.close(() => res())
          })
        },
      })
    })
  })
}

/* ------------------------------------------------------------------ *
 * Supervised Chromium — the test owns the OS process and kills it
 * externally. Nothing inside the page can run after the kill.
 * ------------------------------------------------------------------ */

interface SupervisedBrowser {
  readonly pid: number
  connect(): Promise<Browser>
  /** External process-tree kill; idempotent. Resolves with the observed exit. */
  killTree(): Promise<{ readonly code: number | null; readonly signal: string | null }>
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function killProcessTree(child: ChildProcess): void {
  if (child.pid === undefined) return
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {
      // Already gone — the exit observer below decides.
    }
    return
  }
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone — the exit observer below decides.
    }
  }
}

async function launchSupervised(options: {
  readonly profileDir: string
}): Promise<SupervisedBrowser> {
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${options.profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // Launch on a blank page: connecting over CDP while the app's
    // dev-server page is still loading stalls the handshake. The tests
    // navigate to the app explicitly after connecting (same profile,
    // same database).
    'about:blank',
  ]
  if (process.env['CI'] !== undefined) args.push('--no-sandbox', '--disable-dev-shm-usage')
  const child = spawn(chromium.executablePath(), args, {
    stdio: ['ignore', 'ignore', 'pipe'],
    // Own process group on POSIX so one SIGKILL takes the whole tree.
    detached: process.platform !== 'win32',
  })
  let stderr = ''
  const exitPromise = new Promise<{ code: number | null; signal: string | null }>((res) => {
    child.once('exit', (code, signal) => res({ code, signal }))
  })
  const wsUrl = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(`chromium reported no DevTools endpoint within 30000 ms; stderr:\n${stderr}`),
        ),
      30_000,
    )
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`chromium exited early with code ${code}; stderr:\n${stderr}`))
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(match[1])
      }
    })
  })
  return {
    pid: child.pid ?? -1,
    connect() {
      return chromium.connectOverCDP(wsUrl)
    },
    async killTree() {
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child)
      return withTimeout(exitPromise, 30_000, 'chromium did not exit within 30000 ms of the kill')
    },
  }
}

/* ------------------------------------------------------------------ *
 * Disposable profiles and cleanup.
 * ------------------------------------------------------------------ */

function makeProfileDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Remove leftover disposable profiles (`nv1-*` under the OS temp dir) —
 * ours only. Runs at suite start so even a hard-aborted earlier attempt
 * (e.g. a hook timeout that outran its finally block) cannot leave
 * persistent test data behind.
 */
function sweepStaleProfiles(): void {
  for (const entry of readdirSync(tmpdir(), { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('nv1-')) continue
    try {
      removeDirWithRetry(join(tmpdir(), entry.name))
    } catch {
      // A locked stale dir must not fail the suite; the next run retries.
    }
  }
}

function removeDirWithRetry(dir: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= 10) throw error
      // Windows may hold transient profile locks after a hard kill;
      // bounded cleanup retry — not test synchronization.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
}

/* ------------------------------------------------------------------ *
 * Test-only instrumentation (runs in the page via addInitScript).
 * ------------------------------------------------------------------ */

async function installInstrumentation(
  page: Page,
  options: { readonly mode: 'crash' | 'observe'; readonly url: string },
): Promise<void> {
  await page.addInitScript(
    (arg: { readonly mode: string; readonly url: string }) => {
      type MarkedTransaction = IDBTransaction & { __nv1Restore?: { puts: number } }
      const storeProto = IDBObjectStore.prototype
      const originalClear = storeProto.clear
      const originalPut = storeProto.put
      const signal = (putsInTx: number): void => {
        const payload = JSON.stringify({
          mode: arg.mode,
          store: 'drugs',
          op: 'put',
          clearSeen: 1,
          putsInTx,
        })
        if (arg.mode === 'crash') {
          // Synchronous XHR: notify the supervisor, then block this main
          // thread inside the transaction's success dispatch forever
          // (the server withholds the response). The real transaction
          // stays open and uncommitted until the browser process is
          // killed from the outside. The instrumentation only blocks
          // the event loop — it never aborts or influences the
          // transaction's outcome.
          const xhr = new XMLHttpRequest()
          xhr.open('POST', arg.url, false)
          xhr.send(payload)
          return
        }
        // Observe mode: fire-and-forget; the transaction runs on to a
        // normal commit.
        void fetch(arg.url, { method: 'POST', body: payload }).catch(() => undefined)
      }
      storeProto.clear = function patchedClear(this: IDBObjectStore) {
        const request = originalClear.call(this)
        if (this.name === 'drugs') {
          // The restore is the ONLY operation in this session that
          // clears the drugs store: this marks THE restore transaction.
          ;(this.transaction as MarkedTransaction).__nv1Restore = { puts: 0 }
        }
        return request
      }
      storeProto.put = function patchedPut(
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ): IDBRequest {
        const request = originalPut.call(this, value, key)
        const marked = (this.transaction as MarkedTransaction).__nv1Restore
        if (this.name === 'drugs' && marked !== undefined) {
          request.addEventListener('success', () => {
            marked.puts += 1
            // Crash checkpoint: clear + put#1 applied, put#2 applied at
            // this dispatch — the transaction is genuinely in flight.
            if (marked.puts === 2) signal(marked.puts)
          })
        }
        return request
      }
    },
    options,
  )
}

/* ------------------------------------------------------------------ *
 * Raw-storage snapshot (direct IndexedDB reads — byte-level truth).
 * ------------------------------------------------------------------ */

interface RawSnapshot {
  readonly drugs: readonly Record<string, unknown>[]
  readonly meta: readonly Record<string, unknown>[]
  readonly revisions: readonly { readonly id: string; readonly revision: number }[]
}

async function rawSnapshot(page: Page): Promise<RawSnapshot> {
  const snapshot = await page.evaluate(async () => {
    const open = (): Promise<IDBDatabase> =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('neuropharmacology-sandbox')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    const db = await open()
    const readAll = <T>(store: string): Promise<T[]> =>
      new Promise<T[]>((resolve, reject) => {
        const txn = db.transaction(store, 'readonly')
        const request = txn.objectStore(store).getAll()
        request.onsuccess = () => resolve(request.result as T[])
        request.onerror = () => reject(request.error)
      })
    const [drugs, meta, revisions] = await Promise.all([
      readAll<Record<string, unknown>>('drugs'),
      readAll<Record<string, unknown>>('meta'),
      readAll<{ id: string; revision: number }>('revisions'),
    ])
    db.close()
    const byId = <T extends { readonly id?: unknown }>(a: T, b: T): number =>
      String(a.id).localeCompare(String(b.id))
    return {
      drugs: [...drugs].sort(byId),
      meta: [...meta].sort(byId),
      revisions: [...revisions].sort(byId),
    }
  })
  return snapshot as unknown as RawSnapshot
}

/* ------------------------------------------------------------------ *
 * App driving helpers (real UI flows only).
 * ------------------------------------------------------------------ */

async function appPage(supervised: SupervisedBrowser): Promise<Page> {
  const browser = await supervised.connect()
  const context = browser.contexts()[0]
  if (context === undefined) throw new Error('CDP connection exposed no browser context')
  // The supervised browser launches on `about:blank` (connecting over
  // CDP while the app's dev-server page is still loading stalls the
  // handshake); every flow below navigates explicitly.
  const existing = context.pages().find((candidate) => candidate.url().startsWith(APP_URL))
  const page = existing ?? (await context.newPage())
  // Deterministic layout, matching the ordinary suite's Desktop Chrome
  // viewport.
  await page.setViewportSize({ width: 1280, height: 720 })
  return page
}

async function importNpslBuffer(
  page: Page,
  name: string,
  text: string,
  mode: 'merge' | 'replace',
): Promise<void> {
  await page.goto(`${APP_URL}/import-export`)
  await expect(page.getByTestId('library-record-count')).toBeVisible()
  await page.getByTestId('npsl-file-input').setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(text, 'utf8'),
  })
  await expect(page.getByTestId('import-preview')).toBeVisible()
  // Fail fast with the actual rejection instead of waiting on controls
  // that an invalid preview never renders.
  if ((await page.getByTestId('import-errors').count()) > 0) {
    throw new Error(
      `NPSL preview rejected ${name}: ${await page.getByTestId('import-errors').innerText()}`,
    )
  }
  if (mode === 'replace') {
    await page.getByTestId('import-mode').selectOption('replace', { timeout: 20_000 })
    await page.getByTestId('replace-acknowledge').check()
  }
  await page.getByTestId('confirm-import').click()
  await expect(page.getByTestId('import-report')).toContainText(`Import complete (${mode})`)
}

/**
 * Write ONE raw row through narrowly-scoped direct IndexedDB access —
 * the same sanctioned raw-storage touch e2e/recovery.spec.ts uses.
 * `negativeZero` marks a value assembled INSIDE the page, because the
 * CDP transport normalizes a `-0` passed as an evaluate argument.
 */
async function seedRawRow(
  page: Page,
  row: Record<string, unknown>,
  options: { readonly negativeZero?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    async (arg: { row: Record<string, unknown>; negativeZero: boolean }) => {
      const value = structuredClone(arg.row)
      if (arg.negativeZero) {
        const targets = value['targets'] as { kd: { value: number } }[]
        targets[0]!.kd.value = -0 // assembled in-page: survives structured clone
      }
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('neuropharmacology-sandbox')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      await new Promise<void>((resolve, reject) => {
        const txn = db.transaction('drugs', 'readwrite')
        txn.objectStore('drugs').put(value)
        txn.oncomplete = () => resolve()
        txn.onerror = () => reject(txn.error)
        txn.onabort = () => reject(txn.error)
      })
      db.close()
    },
    { row, negativeZero: options.negativeZero ?? false },
  )
}

/** R5: archive-only row whose kd is `-0` — the recovery numeric sidecar case. */
const RAW_R5_NEGATIVE_ZERO = {
  id: R5_ID,
  origin: 'user',
  persistenceVersion: 2,
  identifiers: { name: 'NV1 Sidecar Epsilon', synonyms: [] },
  tags: ['synthetic-fixture'],
  targets: [
    {
      id: 'nv1r5',
      name: 'NV1R5',
      kd: {
        value: 0, // replaced with -0 in-page before the write
        unit: 'nM',
        provenance: {
          type: 'literature',
          source: 'Synthetic NV1 source',
          citation: 'Invented for tests, 2026',
        },
      },
    },
  ],
  pharmacokinetics: {},
  createdAt: '2026-02-05T00:00:00.000Z',
  updatedAt: '2026-02-05T00:00:00.000Z',
  xNv1Extension: 'sidecar-extension-marker',
}

/** Seed the old library exactly as the crash test needs it. */
async function seedOldLibrary(page: Page): Promise<void> {
  await importNpslBuffer(page, 'nv1-old-library.npsl', OLD_NPSL, 'merge')
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 2 records.*Local library/,
  )
  await seedRawRow(page, RAW_R3)
  await page.reload()
  await expect(page.getByTestId('library-record-count')).toHaveText(
    /Current library: 3 records.*Local library/,
  )
  // One real UI edit on R1 → its revision advances 1 → 2, so the
  // pre-crash revision oracle is non-trivial.
  await page.goto(`${APP_URL}/library/${R1_ID}`)
  await page.getByTestId('edit-drug').click()
  await expect(page.getByTestId('drug-form')).toBeVisible()
  await page.locator('#drug-tags').fill('synthetic-fixture, nv1-pre-crash-edit')
  await page.getByTestId('save-drug').click()
  await expect(page.getByTestId('drug-detail')).toBeVisible()
  await expect(page.getByTestId('param-Kd')).toContainText('4.2 nM')
}

/** Drive the real Recovery restore up to (but not past) the confirm click. */
async function stageRestore(page: Page, archiveText: string): Promise<void> {
  await page.goto(`${APP_URL}/import-export`)
  await page.getByTestId('tab-recovery').click()
  await page.getByTestId('recovery-restore-file').setInputFiles({
    name: 'nv1-archive.npsb',
    mimeType: 'application/json',
    buffer: Buffer.from(archiveText, 'utf8'),
  })
  await expect(page.getByTestId('recovery-preview')).toBeVisible()
  await expect(page.getByTestId('recovery-preview-counts')).toContainText('4 stored rows')
  await expect(page.getByTestId('recovery-restore-confirm')).toBeDisabled()
  await page.getByTestId('recovery-acknowledge').check()
  await expect(page.getByTestId('recovery-restore-confirm')).toBeEnabled()
}

/* ------------------------------------------------------------------ *
 * Shared archive built once per worker in its own disposable profile:
 * replace-import the archive library, raw-seed the `-0` sidecar row,
 * export through the real Recovery UI, hard-kill the profile's browser.
 * ------------------------------------------------------------------ */

interface BuiltArchive {
  readonly text: string
  readonly parsed: {
    readonly counts: { readonly drugRows: number }
    readonly drugs: readonly {
      readonly key: string
      readonly value: Record<string, unknown>
      readonly specialNumbers?: readonly { readonly path: string; readonly kind: string }[]
    }[]
    readonly meta: readonly { readonly key: string; readonly value: Record<string, unknown> }[]
  }
}

let archiveText: string | undefined

test.beforeAll(async () => {
  test.setTimeout(120_000)
  sweepStaleProfiles()
  const profile = makeProfileDir('nv1-archive-')
  const supervised = await launchSupervised({ profileDir: profile })
  try {
    const page = await appPage(supervised)
    await importNpslBuffer(
      page,
      'nv1-archive-source.npsl',
      archiveNpsl(RAW_R5_NEGATIVE_ZERO),
      'replace',
    )
    await expect(page.getByTestId('library-record-count')).toHaveText(
      /Current library: 4 records.*NV1 Archive Library/,
    )
    // Replace import cannot carry `-0` (JSON normalizes it); re-seed the
    // same id as a raw row with the value assembled in-page.
    await seedRawRow(page, RAW_R5_NEGATIVE_ZERO, { negativeZero: true })
    await page.reload()
    await expect(page.getByTestId('library-record-count')).toHaveText(
      /Current library: 4 records.*NV1 Archive Library/,
    )
    await page.getByTestId('tab-recovery').click()
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('recovery-export').click(),
    ])
    const filePath = await download.path()
    if (filePath === null) throw new Error('recovery export download produced no file')
    archiveText = readFileSync(filePath, 'utf8')
    await expect(page.getByTestId('recovery-export-status')).toHaveText(/Downloaded/)
  } finally {
    await supervised.killTree().catch(() => undefined)
    removeDirWithRetry(profile)
  }
})

test.afterAll(() => {
  archiveText = undefined
})

function builtArchive(): BuiltArchive {
  if (archiveText === undefined) throw new Error('archive was not built in beforeAll')
  const parsed = JSON.parse(archiveText) as BuiltArchive['parsed'] & { formatId: string }
  if (parsed.formatId !== 'npsb') throw new Error('exported archive is not an .npsb document')
  return { text: archiveText, parsed }
}

/* ------------------------------------------------------------------ *
 * Test 1 — the crash scenario.
 * ------------------------------------------------------------------ */

test('NV-1: killing the browser process mid-restore rolls the transaction back atomically', async () => {
  const archive = builtArchive()
  expect(archive.parsed.counts.drugRows).toBe(4)
  expect(archive.parsed.drugs.map((entry) => entry.key).sort()).toEqual([
    R1_ID,
    R2_ID,
    R4_ID,
    R5_ID,
  ])

  const profile = makeProfileDir('nv1-crash-')
  const checkpoint = await startCheckpointServer()
  const launched: SupervisedBrowser[] = []
  const spawnSupervised = async (): Promise<SupervisedBrowser> => {
    const supervised = await launchSupervised({ profileDir: profile })
    launched.push(supervised)
    return supervised
  }
  try {
    // ---- Seed the old library and capture the raw pre-crash state. ----
    const seeder = await spawnSupervised()
    const page = await appPage(seeder)
    await seedOldLibrary(page)
    const before = await rawSnapshot(page)
    expect(before.drugs).toHaveLength(3)
    expect(before.revisions).toEqual([
      { id: R1_ID, revision: 2 },
      { id: R2_ID, revision: 1 },
    ])
    expect(before.meta).toHaveLength(1)
    expect(before.meta[0]).toMatchObject({ id: 'local-library', name: 'Local library' })

    // ---- Trigger the REAL restore with the crash instrumentation
    //      armed; the transaction stalls at its checkpoint. ----
    await installInstrumentation(page, { mode: 'crash', url: checkpoint.url })
    await page.reload()
    await stageRestore(page, archive.text)
    // The next click enters the production restore transaction. From
    // here on the test NEVER touches the page again — the checkpoint
    // server is the only channel, and the kill is external.
    await page.getByTestId('recovery-restore-confirm').click()

    const evidence = await checkpoint.evidence(45_000)
    expect(evidence).toEqual({
      mode: 'crash',
      store: 'drugs',
      op: 'put',
      clearSeen: 1,
      putsInTx: 2,
    })

    // ---- Kill the whole browser PROCESS tree while the transaction
    //      is active; observe the OS-level exit. ----
    const exit = await seeder.killTree()
    console.log(
      `[nv1] crash checkpoint reached (store=${evidence.store}, op=${evidence.op}, clearSeen=${evidence.clearSeen}, putsInTx=${evidence.putsInTx}); killed chromium pid=${seeder.pid}; observed exit code=${String(exit.code)} signal=${String(exit.signal)}`,
    )

    // ---- Restart: a fresh Chromium process on the SAME profile. ----
    const verifier = await spawnSupervised()
    const reopened = await appPage(verifier)

    // UI hydration: the ENTIRE old library, nothing half-restored.
    await reopened.goto(`${APP_URL}/library`)
    await expect(reopened.getByTestId('drug-list')).toContainText('NV1 Old Compound Alpha')
    await expect(reopened.getByTestId('drug-list')).toContainText('NV1 Old Compound Beta')
    await expect(reopened.getByTestId('drug-list')).toContainText('NV1 Raw-Seeded Gamma')
    await expect(reopened.getByTestId('quarantine-banner')).toHaveCount(0)
    await reopened.goto(`${APP_URL}/import-export`)
    await expect(reopened.getByTestId('library-record-count')).toHaveText(
      /Current library: 3 records.*Local library/,
    )
    // The app must not mistake the interrupted transaction for a
    // successful restore: a fresh session shows no restore report.
    await reopened.getByTestId('tab-recovery').click()
    await expect(reopened.getByTestId('recovery-restore-report')).toHaveCount(0)

    // Raw-storage equality: the interrupted transaction left NO trace —
    // drug rows (unknown fields, provenance, source references),
    // metadata, and revision entries are exactly the pre-crash bytes.
    const after = await rawSnapshot(reopened)
    expect(after).toEqual(before)

    // R1 still renders its original science and provenance from the
    // surviving storage (badge title carries the literature source).
    await reopened.goto(`${APP_URL}/library/${R1_ID}`)
    await expect(reopened.getByTestId('param-Kd')).toContainText('4.2 nM')
    await expect(
      reopened.locator('[data-testid="provenance-badge"][title*="Synthetic NV1 source"]'),
    ).toBeVisible()
    await expect(reopened.getByText('CHEMBL99992001')).toBeVisible()
  } finally {
    for (const supervised of launched) await supervised.killTree().catch(() => undefined)
    await checkpoint.close().catch(() => undefined)
    removeDirWithRetry(profile)
  }
})

/* ------------------------------------------------------------------ *
 * Test 2 — positive control with the same harness.
 * ------------------------------------------------------------------ */

test('NV-1 positive control: a committed restore survives the same process kill and restart', async () => {
  const archive = builtArchive()
  const profile = makeProfileDir('nv1-control-')
  const checkpoint = await startCheckpointServer()
  const launched: SupervisedBrowser[] = []
  const spawnSupervised = async (): Promise<SupervisedBrowser> => {
    const supervised = await launchSupervised({ profileDir: profile })
    launched.push(supervised)
    return supervised
  }
  try {
    // ---- Same old library, same seeding path. ----
    const seeder = await spawnSupervised()
    const page = await appPage(seeder)
    await seedOldLibrary(page)
    const before = await rawSnapshot(page)

    // ---- Same restore, observe mode: the transaction is allowed to
    //      COMMIT (fire-and-forget evidence only). ----
    await installInstrumentation(page, { mode: 'observe', url: checkpoint.url })
    await page.reload()
    await stageRestore(page, archive.text)
    await page.getByTestId('recovery-restore-confirm').click()

    // Commit proof: the store awaited the repository transaction and
    // rendered the committed report; the observe-mode checkpoint (the
    // same clear + put#2 signature) was received.
    const evidence = await checkpoint.evidence(45_000)
    expect(evidence).toEqual({
      mode: 'observe',
      store: 'drugs',
      op: 'put',
      clearSeen: 1,
      putsInTx: 2,
    })
    await expect(page.getByTestId('recovery-restore-report')).toContainText('Restore complete')
    await expect(page.getByTestId('library-record-count')).toHaveText(
      /Current library: 4 records.*NV1 Archive Library/,
    )

    // ---- The same external kill, AFTER the commit, then restart the
    //      same profile: the committed state must survive. ----
    const killed = await seeder.killTree()
    console.log(
      `[nv1] committed restore observed; killed chromium pid=${seeder.pid}; observed exit code=${String(killed.code)} signal=${String(killed.signal)}`,
    )
    const verifier = await spawnSupervised()
    const reopened = await appPage(verifier)

    await reopened.goto(`${APP_URL}/library`)
    await expect(reopened.getByTestId('drug-list')).toContainText('NV1 Restored Alpha')
    await expect(reopened.getByTestId('drug-list')).toContainText('NV1 Restored Delta')
    await expect(reopened.getByTestId('drug-list')).not.toContainText('NV1 Raw-Seeded Gamma')
    await reopened.goto(`${APP_URL}/import-export`)
    await expect(reopened.getByTestId('library-record-count')).toHaveText(
      /Current library: 4 records.*NV1 Archive Library/,
    )

    // Raw-storage oracle: drugs/meta byte-equal the ARCHIVE rows;
    // revisions advanced by exactly one for every restored id, with the
    // old-only record's absence preserved (no invented entries).
    const after = await rawSnapshot(reopened)
    // The archive's JSON carries R5's kd as a 0 placeholder plus a `-0`
    // sidecar annotation (asserted here); the restore materialized the
    // real `-0` back into the row, so the expected row mirrors that.
    const sidecarEntry = archive.parsed.drugs.find((entry) => entry.key === R5_ID)
    expect(
      sidecarEntry?.specialNumbers?.some(
        (annotation) => annotation.kind === '-0' && annotation.path.includes('kd'),
      ),
    ).toBe(true)
    const archiveDrugs = archive.parsed.drugs
      .map((entry) => entry.value)
      .sort((a, b) => String(a['id']).localeCompare(String(b['id'])))
    const sidecarTargets = archiveDrugs.find((row) => row['id'] === R5_ID)?.['targets'] as
      | { kd: { value: number } }[]
      | undefined
    if (sidecarTargets?.[0] !== undefined) sidecarTargets[0].kd.value = -0
    const revisionOf = (id: string): number =>
      before.revisions.find((entry) => entry.id === id)?.revision ?? 0
    expect(after.drugs).toEqual(archiveDrugs)
    expect(after.meta).toEqual(archive.parsed.meta.map((entry) => entry.value))
    expect(after.revisions).toEqual([
      { id: R1_ID, revision: revisionOf(R1_ID) + 1 },
      { id: R2_ID, revision: revisionOf(R2_ID) + 1 },
      { id: R4_ID, revision: 1 },
      { id: R5_ID, revision: 1 },
    ])
    expect(after.revisions.find((entry) => entry.id === R3_ID)).toBeUndefined()

    // The numeric sidecar materialized `-0` back (asserted in-page: the
    // CDP transport normalizes -0, so Object.is must run in storage's
    // realm).
    const negativeZeroRestored = await reopened.evaluate(async () => {
      const db: IDBDatabase = await new Promise((resolve, reject) => {
        const request = indexedDB.open('neuropharmacology-sandbox')
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
      const row = await new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
        const txn = db.transaction('drugs', 'readonly')
        const request = txn.objectStore('drugs').get('nv1-r5')
        request.onsuccess = () => resolve(request.result as Record<string, unknown> | undefined)
        request.onerror = () => reject(request.error)
      })
      db.close()
      const targets = row?.['targets'] as { kd: { value: number } }[] | undefined
      return Object.is(targets?.[0]?.kd.value, -0)
    })
    expect(negativeZeroRestored).toBe(true)

    // Changed science renders from the surviving storage.
    await reopened.goto(`${APP_URL}/library/${R1_ID}`)
    await expect(reopened.getByTestId('param-Kd')).toContainText('88.8 nM')
    await expect(reopened.getByText('CHEMBL99992009')).toBeVisible()
  } finally {
    for (const supervised of launched) await supervised.killTree().catch(() => undefined)
    await checkpoint.close().catch(() => undefined)
    removeDirWithRetry(profile)
  }
})
