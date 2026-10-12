# NV-2 Authorized Legacy Database Validation Protocol

> **Status (phase 24): protocol prepared — nothing verified.** Audit NV-2
> ("v1→v2 migration against real legacy user data",
> `docs/data-integrity-audit.md` §6) remains **open**. No authentic
> historical user database has ever been obtained or inspected, and this
> document itself verifies nothing. It exists so that, **if and only if**
> the owner of an authentic historical database explicitly authorizes a
> local validation, an operator can run one safely, repeatably and
> honestly — with clearly labeled evidence and hard stop conditions.

---

## 1. Purpose and scope

This runbook defines a future, authorization-first procedure for
validating that the current application migrates an **authentic legacy
database** correctly. It covers:

- the authorization and provenance gate (§3),
- preservation of the original and isolation of the validation
  environment (§4),
- the evidence classes and what each one proves (§2),
- the deterministic execution sequence and its stop conditions (§5, §8),
- privacy and evidence handling (§7), and
- the explicit checklist that governs whether NV-2 may ever be closed
  (§9).

It does **not** provide, collect or discover user data; it adds no
importer, profile scanner or telemetry; and it must never be read as
evidence that NV-2 is fixed. The existing synthetic evidence — the
`fake-indexeddb` unit fixtures (`src/data/db/database.test.ts`) and the
real-Chromium migration suite (`e2e/migration.spec.ts`, `docs/testing.md`
§4.13) — proves the upgrade **mechanism**; only authorized authentic
data can prove the **data path** (§9).

## 2. Evidence classes — never collapsed into one claim

| Class | What it is | What it proves | What it does NOT prove |
| --- | --- | --- | --- |
| **A — Authentic physical database, tested directly** | An owner-supplied **copy** of the real legacy database/profile is opened by the *current application* through Chromium's real versionchange upgrade, in an isolated profile on the exact historical origin | That the real physical database (its true native version, its actual stores/indexes, its real rows and metadata) migrates through the live application path and hydrates | Nothing about browsers/origins not actually exercised; nothing about other owners' databases with different content; it does not retroactively verify history |
| **B — Authentic row payloads, reseeded** | Row payloads exported (locally, read-only) from an authorized legacy database copy and reseeded into a **test database at the historical native version**, then migrated by the current app | That *authentic record content* (real field mixes, real unknown fields, real formats) survives the documented migration + mapping + hydration contract | That the *physical* database file is intact or at the assumed version; leveldb-level state; stores/indexes the export did not capture. **Class B alone is not automatically sufficient to close NV-2** — see §9 |
| **C — Synthetic fixtures only** | The committed mechanism tests: `database.test.ts` (`fake-indexeddb`) and `e2e/migration.spec.ts` (raw-IDB seeds at native 10/20/30 in real Chromium) | The upgrade mechanism behaves exactly as documented for every schema generation we ever shipped (backfill semantics, additive stores, tripwires, reopen) | Any statement about authentic user data. Synthetic rows can never substitute for a real historical database |

A validation report must name the class it belongs to. Phrases such as
"real-database verification" are forbidden unless they actually mean
Class A; a Class B run must say "authentic row payloads, reseeded"; a
Class C run must say "synthetic". If reconnaissance of a specific
supplied artifact suggests a stronger feasible approach than the ones
above, it must be justified in writing (from the actual origin, browser
and schema facts) **before** execution — not improvised mid-run, and not
by building a speculative importer or profile converter.

## 3. Gate 1 — Authorization and provenance (stop without it)

Before any source data is touched, the operator records a signed-off
provenance statement (free text, kept local) that answers **all** of:

1. **Ownership and authorization.** Who owns the database, and who
   explicitly authorized this validation? If the operator is not the
   owner, the owner must authorize each access step in writing. Access
   to another person's browser profile or database without such
   authorization is out of scope of this protocol entirely — the
   procedure must not be used to obtain it.
2. **Permission for this purpose.** The supplied copy is permitted for
   this specific *local* validation — no upload to GitHub, no AI agent,
   no third-party service, no CI runner, no sharing beyond the stated
   terms (see §7).
3. **Source application and origin.** Source application, browser (and
   major version if known), exact origin (scheme + host + port) the
   historical instance ran on, and approximate historical period.
4. **Schema generation — known or suspected.** Which application era
   wrote it (v1/v2/v3 builds; native IndexedDB version 10/20/30 under
   the `dexie@4.4.6` × 10 scheme; see `e2e/migration.spec.ts` header),
   and any uncertainty about that provenance.
5. **Sharing restrictions.** Whether the owner permits local processing
   only and/or prohibits onward sharing of anything derived (checksums
   included — see §7).

If any answer is missing, uncertain or later found wrong, the procedure
**stops before accessing the data** and NV-2 stays open. There is no
partial-progress fallback.

## 4. Gate 2 — Preserve the original, isolate the environment

### 4.1 Copies only

- Accept **only** a copy explicitly supplied or prepared by the
  authorized owner (archive or profile-directory copy). Never point any
  browser or tool at the owner's live/original location.
- Record a checksum (e.g. SHA-256) of the supplied archive/copy. Its
  purpose is transfer-integrity and provenance traceability *only*; it
  is a data-derived fingerprint and stays local unless the owner
  explicitly approves sharing (§7).
- Preserve the supplied original **unchanged**. Every probe, migration
  and experiment runs on a separate **disposable copy** created with a
  documented file copy. After creation, the disposable copy is the only
  thing any browser may open.
- Working location: an **operator-selected local path outside this
  repository's working tree** (e.g. a sibling directory). The repo
  `.gitignore` does not cover IndexedDB/LevelDB blobs, so anything
  placed inside the tree risks being committed by accident — outside the
  tree is mandatory, not optional.
- **Never open the original with the current application.** A real
  legacy database (native 10/20/30) is upgraded **in place** by the
  v4 open path (Dexie declared 4 → native 40) — on the original that
  would irreversibly mutate the owner's only historical artifact. The
  same caution applies to *any* browser, even a versionless probe
  (browsers may touch log/journal files inside a profile they open):
  every browser session below targets the disposable copy only.

### 4.2 Physical-profile feasibility checklist

For a Chromium/IndexedDB profile copy, decide feasibility **before**
promising a Class A run. Verified constraints from this repository and
Chromium's layout:

- **Origin.** Chromium partitions IndexedDB per origin
  (`Default/IndexedDB/<scheme>_<host>_<port>.indexeddb.leveldb`, e.g.
  `http_localhost_5173.indexeddb.leveldb`). The current app must be
  served on the **exact historical origin — port included** — or
  Chromium will present the app with a different (empty) storage
  partition and no authentic data will be exercised. The app is
  origin-binder-friendly (`npm run dev -- --port <PORT> --strictPort`,
  or a built `vite preview` on the same port), so a known localhost
  origin is usually servable. If the historical origin is unknown,
  unreachable, or requires TLS/hosting we cannot reproduce locally,
  Class A is **not feasible** → document the limitation and stop (or
  downgrade to Class B with fresh owner authorization for the export).
- **Browser version.** Launch the bundled Playwright Chromium
  (`npx playwright install chromium` — same mechanism the crash harness
  uses). Its major version must be **≥ the browser that wrote the
  profile**; older Chromium builds must not be introduced to "match"
  history. The browser may upgrade profile internals **in place** —
  another reason only the disposable copy is ever opened.
- **Locking and completeness.** The source browser — and any other
  process that could write the profile — must have been **fully exited
  before the copy was made**, and the owner must confirm and document
  that fact. Merely owning the copy does not prove it was taken from a
  quiescent, consistent profile. If the owner cannot confirm a
  fully-exited copy, request a fresh, consistent owner-prepared copy or
  stop — never open the original to inspect it. The copy must include
  the whole profile directory (or at minimum the origin's `IndexedDB`
  subtree plus the minimal profile metadata next to it), and no second
  process may hold the disposable copy open.
- **Profile-format constraints.** The disposable profile is opened only
  by this Chromium build via a supervised launch — never merged back
  into, or compared with, the owner's profile layout.

If any item fails, a physical replay cannot be improvised safely: state
the limitation in the report and stop.

### 4.3 Establishing the initial state without migrating the source

Before the current application goes anywhere near the disposable copy,
record the best available pre-migration evidence **through raw APIs
only** (no Dexie, no app code — the same discipline as
`e2e/migration.spec.ts`):

1. Inventory first, on the correct origin: call
   `indexedDB.databases()` from a same-origin probe page. It lists
   database names and their **current native versions** without
   opening anything — and therefore without any upgrade.
2. Locate the exact expected database by name
   (`neuropharmacology-sandbox`, `src/data/db/database.ts`).
3. Confirm that it **exists** and that its **`version` is defined**.
   If the database is absent, or its version is undefined, **stop
   without ever calling `indexedDB.open(name)`** and document why:
   per MDN, a versionless `indexedDB.open(name)` against a database
   that does not exist **creates** it at version 1 — fabricating a
   misleading empty "historical" database inside the disposable copy
   and blurring a missing or wrong origin partition with a real one.
4. Only now inspect the schema without upgrading: a versionless
   `indexedDB.open(name)` (no version argument) opens the *existing*
   database at its existing version — no `versionchange` fires. Read
   `objectStoreNames`, each store's `keyPath` and its index
   names/paths inside a read-only transaction.
5. Compare against the expected generations (`src/data/db/database.ts`,
   schemas verified from the original commits `b178c0d` / `5146264` /
   `de95c95`): native 10 ⇔ declared v1, 20 ⇔ v2, 30 ⇔ v3, 40 ⇔ current
   v4. **Anything else is an unexpected schema — stop (§8).** The
   starting version also fixes which migration path the run may later
   claim — see the table in §5 step 2.

The probe page is a minimal same-origin document served by request
interception (or a tiny static file on the app server) that never loads
the application bundle — reuse the pattern from `e2e/migration.spec.ts`.

## 5. Class A execution sequence (deterministic)

All browser work uses the supervised-launch pattern already proven in
this repository (`e2e-crash/crash-durability.spec.ts`): spawn
`chromium.executablePath()` with a dedicated
`--user-data-dir=<disposable-copy>` and `--remote-debugging-port=0`,
then drive it over CDP (`chromium.connectOverCDP`). Steps:

1. **Pre-flight.** Confirm signed-off Gate 1 (§3) and Gate 2 (§4):
   authorization, provenance statement, feasibility checklist, source
   checksum, pristine disposable copy, working path outside the repo.
2. **Pre-migration evidence** (§4.3) against the disposable copy:
   native version, store/index inventory, sanitized per-store counts.
   If the native version is not one of 10/20/30/40 → stop. The
   starting version fixes which migration path this run can evidence:
   - **native 10** — the only starting point that exercises the
     **v1→v2 bookkeeping hook** (the path NV-2 is specifically about),
     followed by the additive v3/v4 upgrades;
   - **native 20 or 30** — starts at v2/v3; the v1→v2 hook does
     **not** run. These starts can yield useful authentic
     preservation/hydration evidence, but the report must state
     explicitly that the v1→v2 path was **not exercised**;
   - **native 40** — already the current schema; opening it exercises
     **no historical upgrade** (baseline/hydration check only) and
     must never be reported as a legacy-migration pass.
3. **Serve the current app on the exact historical origin** (dev or
   preview server on the recorded port) and establish + **verify** the
   independently enforced outbound-network boundary (§7) — with the
   supplementary request interception installed on the validation
   context — *before* any navigation. If the boundary cannot be
   established and verified, stop here: no app navigation happens.
4. **Run the current application** against the disposable copy: navigate
   the supervised browser to the app origin; the normal open path
   performs the real upgrade (v1-era DBs get exactly the documented
   v1→v2 bookkeeping backfill — shared-stamp semantics; v2/v3-era DBs
   get the additive v3/v4 stores only; `src/data/db/database.ts`).
   Record: the migration path actually exercised (per step 2's
   starting version), upgrade outcome (expected native 40),
   console/storage errors, boundary and interception-log state.
5. **In-app validation, sanitized.** Library hydration via the UI
   (drug list, count, quarantine banner) plus raw post-migration
   snapshots (version, store/index inventory, counts). Record only
   counts, versions and field paths — never record contents (§7).
6. **Close/reopen persistence.** Close the context and the browser
   process; relaunch on the same disposable copy; re-probe native
   version (expect 40 — reopening must not mutate again) and compare
   sanitized snapshots/hydration counts with step 5.
7. **Preserve evidence, then deliberate cleanup.** Write the sanitized
   report (§7 template) and keep the provenance statement,
   pre-migration evidence, boundary-verification record and
   interception-log summary at the local working path. Then
   delete **only** the disposable copy (documented, deliberate command —
   e.g. removing that one directory); the owner-supplied original and
   all reports remain untouched.

Any failure along the way is a stop condition (§8), not a cue to relax
the sequence.

## 6. Class B — authorized row-payload reseeding (fallback)

Only with fresh, explicit owner authorization for the read-only export,
and only from a disposable copy (§4.1 — never the original):

1. Export per-store row payloads via the same versionless probe page
   (`getAll()`), written to local files at the operator-selected path,
   never into this repository.
2. Reseed a **fresh** test database at the authentic historical native
   version (10/20/30) with the historical store/index layout copied
   from the original schema commits — the raw-IDB seeding discipline of
   `e2e/migration.spec.ts` (seed before the app ever opens the name;
   connections closed; DOM readiness; no sleeps).
3. Run the current app against that derived database in an isolated
   context; record the same sanitized evidence classes as §5.

Class B evidences authentic **content** compatibility; it is **not**
migrating the original physical database. Its report must say so, and
it does not automatically satisfy the closure checklist (§9).

## 7. Privacy and evidence handling (local-only)

Hard rules — the report and the repository must obey all of them:

- **Never commit** a source database, profile copy, raw row dump,
  export file, identifier or user-specific value. Working copies live
  at the operator-selected path outside the repository tree (§4.1).
- **Never place** any of the above in GitHub issues, PR descriptions,
  commit messages, CI artifacts, console logs shown in shared
  recordings, or AI prompts/chat. If an agent assists the operator, the
  operator must not paste record contents into it.
- **Sanitized report only** — the minimum necessary evidence:
  - source/provenance category (e.g. "owner-supplied Chromium profile
    copy, localhost origin, v2-era build"), never machine usernames or
    paths that identify the person;
  - pre-migration native version + store/index summary (names,
    keyPaths, counts);
  - migration result (native version after, upgrade outcome,
    reopen/persistence result);
  - sanitized counts: records read, hydrated, quarantined, failed or
    otherwise unhandled, per store; metadata/revision summary;
  - the migration path actually exercised (starting native version;
    whether the v1→v2 hook ran — stated explicitly as "not exercised"
    for native-20/30 starts and "no historical upgrade" for native-40);
  - network-boundary summary (§ below): the mechanism actually
    enforced, how its enforcement was verified, supplementary
    interception-log counts, and its limitations — plus
    test-execution metadata (tool versions, dates, operator role).
- **No record contents.** Never print names, notes, citations, source
  URLs, provenance objects or arbitrary extension values. When errors
  must identify affected records, report **counts and field paths**
  only — never complete row objects, never raw ids from the data.
- **Checksums/fingerprints stay local** (§3.5): they exist for
  transfer integrity and reproducibility, and are shared only with
  explicit owner approval.
- **Network containment — an enforced boundary, not a browser request
  log.** Playwright request interception (`context.route()` and
  friends) is **supplementary observability and blocking for the
  requests it actually intercepts — never the security boundary**.
  Playwright documents that `BrowserContext.route()` does not
  intercept requests handled by Service Workers and recommends
  disabling Service Workers when relying on routing; a reopened
  physical profile may also carry extensions, persisted Service
  Workers, sync and browser background networking that generate
  traffic outside the ordinary page-request path. A request log, or
  the mere absence of requests in one, is **not** proof of outbound
  denial.
- **"No data left the machine" requires an independently enforced
  outbound-network boundary** for the browser process (or the whole
  isolated validation environment): the only permitted destination is
  the explicitly approved loopback app/probe server, and outbound
  traffic to **every other destination must be blocked by a mechanism
  outside the browser** (an OS firewall rule set, a network
  namespace/container with loopback-only egress, an offline machine,
  or an equivalent, actually-enforced local mechanism). This protocol
  deliberately provides no universal command for every operating
  system — the operator selects a mechanism appropriate to the
  environment, **enforces it, and independently verifies that it
  actually denies outbound traffic** (e.g. an outbound attempt from an
  equivalent process is observed to fail) before the application is
  navigated. If a boundary cannot be established and verified, the run
  **stops before navigating the current application** and must not
  claim local-only.
- **Profile-side traffic sources, accounted for before validation.**
  On the disposable copy, before navigation: extensions
  disabled/removed; persisted Service Workers disabled or removed and
  verified absent for the app origin, so a stale worker **cannot make
  the browser execute an old application bundle instead of the
  current application** (verify the served bundle the page actually
  runs); sync and browser background networking disabled. Anything
  that cannot be disabled is explicitly inspected and accounted for
  in the report.
- **The supplementary interception log stays.** With the boundary
  enforced, the validation context still installs request
  interception before navigation — loopback allowed, everything else
  logged (method + host only) and aborted — and the sanitized log
  summary (counts by host, any data-derived strings in URLs) goes
  into the report as corroborating observability. The application
  normally does reach external data sources at runtime; under an
  enforced boundary those attempts fail at the boundary and are
  counted — never permitted.
- **The claim never exceeds the mechanism.** The sanitized report
  records the boundary mechanism actually enforced, how its denial
  was verified, the supplementary log summary, and the mechanism's
  limitations, and states exactly that and nothing broader. The
  authenticity restrictions above are absolute regardless of
  boundary: source data is never uploaded to GitHub, AI agents,
  external services or CI in any scenario.

## 8. Hard stop conditions

Halt immediately — without data access, mid-run, or before reporting —
and record the reason in the (sanitized) report:

- authorization uncertain, later withdrawn, or provenance unclear;
- source identity unclear (cannot tie the artifact to a historical
  application/schema generation);
- unexpected native version or schema (not 10/20/30/40, or stores that
  match no historical generation);
- any indication the **original** (not the disposable copy) could be
  mutated or was touched;
- any unexpected network transfer (an external host observed in the
  supplementary interception log, outbound traffic the enforced
  boundary (§7) did not deny, or a request we cannot attribute to the
  local app server);
- unreadable database (probe fails, copy incomplete, LevelDB errors);
- unsupported browser/origin setup (infeasible per §4.2);
- migration failure, hydration failures or quarantine counts that the
  documented contract does not explain;
- any residual possibility that the session is touching the user's
  original data rather than the disposable copy.

Stops are final for the run. There is no "continue anyway" branch, no
fabricated success outcome, and no instruction anywhere in this protocol
that bypasses a stop.

## 9. NV-2 closure checklist (all items required)

NV-2 stays **open** until an actual, authorized, inspected authentic
database run satisfies **every** item — and the audit document
(`docs/data-integrity-audit.md` §6) is updated with the reproducible,
sanitized evidence for independent review:

- [ ] Authentic provenance **and** explicit, documented authorization
      (§3) — owner, purpose, sharing terms on record.
- [ ] Defensible link between the data and a historical application /
      schema generation (build reference, era, origin, expected native
      version).
- [ ] The migration ran through the **real application / IndexedDB
      upgrade path** on an isolated **copy** of the authentic database
      (Class A) — or an equally strong method, justified **in advance**
      in the report and accepted on independent review. The evidence
      must actually exercise the **v1→v2 path** NV-2 is about: only a
      Class A run whose authentic database starts at **native 10** does
      so; a run starting at native 20 or 30 does **not** exercise the
      v1→v2 hook and must say so explicitly (it cannot close NV-2 by
      itself); a run starting at native 40 is **no legacy-migration
      pass at all** (baseline/hydration only). Any substitute weaker
      than an authentic native-10 upgrade requires the same explicit,
      in-advance justification and independent-review acceptance as
      the clause above.
- [ ] Documented before/after result for the migration contract,
      including **failed, quarantined or otherwise unhandled records**
      (counts + field paths).
- [ ] Close/reopen persistence verification where feasible (with a
      stated limitation if not).
- [ ] Reproducible sanitized evidence sufficient for an independent
      reviewer to re-evaluate the conclusion (provenance statement,
      versions, inventories, counts, boundary-verification and
      interception-log summaries — no contents).
- [ ] A transparent statement of remaining limitations (single owner's
      data ≠ universal; class actually achieved; anything untested).

**Insufficient on its own, ever:** a synthetic database (class C), an
undocumented export, a successful build, green CI, a Class A run that
never exercised the v1→v2 path (native 20/30/40 starts), this
runbook's existence, or any combination of those.

## 10. Outcome statement

- **If no authentic database becomes available** (the situation in
  phase 24 and, so far, always): the correct and only outcome is
  **"protocol prepared; NV-2 remains open; no authentic-data
  validation performed."**
- **If a validation runs:** the report states the achieved evidence
  class (A or B), every sanitized result, every deviation and stop, and
  the closure checklist outcome. Closing NV-2 additionally requires the
  audit update and review described in §9 — never this report alone.

---

## Appendix — why this phase is documentation-only

The execution sequence deliberately reuses tooling that already exists
and is already verified in this repository:

- supervised Chromium on a dedicated disposable `--user-data-dir` over
  CDP (`e2e-crash/crash-durability.spec.ts`, phase 21),
- same-origin raw-IDB probe/seeding pages that never load the app
  bundle (`e2e/migration.spec.ts`, phase 23),
- origin-pinned local serving (`vite` dev/preview with `--port` /
  `--strictPort`),
- the migration contract itself (`src/data/db/database.ts`).

Any *new* executable tool for this protocol — an importer, a profile
converter, a scanner — could only be verified against authentic data,
which by definition does not exist yet; building one would be
speculative and unverifiable, so none was built. Should a future
authorized run demonstrate a concrete, safe, repeatedly needed manual
step, a tool for that step can be proposed then, designed to be
verifiable without user data.
