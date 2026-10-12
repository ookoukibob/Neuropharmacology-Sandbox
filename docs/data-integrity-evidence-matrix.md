# Data-integrity evidence matrix (phases 22–24)

Produced by the **phase 25 post-merge audit** (read-only verification
against the repository at `main` = `3f20871`, the Phase 24 merge). One
compact claim→evidence map for the recent data-integrity work; it
references the authoritative sections rather than repeating them.

**NV-2 remains OPEN — no authentic historical user database has ever
been obtained or inspected; no authentic-data validation was performed
in phase 25.** Evidence type legend: *synthetic* = fixtures created by
this repository's tests; *authentic* = real historical user data
(none has been obtained or inspected for NV-2 in this project);
*procedure* = a documented process, not evidence.

| # | Claim | Source (file/test/commit/CI) | Actually exercised / observed | Evidence type | Does NOT establish | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | All 57 CSV columns have an explicit, executable import/export contract (NV-3) | `src/features/import-export/csv/csvColumnContract.test.ts` (25 tests; independent literal `EXPECTED_HEADERS` = 57 entries, test:44; runtime `toHaveLength(57)` asserts); `HEADER_DESTINATION` = 16 + 8×5 = 56 destinations; derived `CSV_HEADERS` in `csvExport.ts:85`; contract table `docs/csv-column-contract.md`; audit §6 "Verified in Phase 22" | A fully populated **synthetic marker library** through export → `parseCsv` → explicit mapping → NPSL validation → real Dexie commit + read-back; every loss/transform boundary asserted as policy | Synthetic contract tests | Validity of **arbitrary external user files**; the per-column UI mapping flow (flow-level coverage only — one component test + one Playwright spec, not per column); CSV as a lossless backup (`-0`, unknown fields, pre-import `origin` excluded **by design**) | Verified (contract) — audit NV-3 closed, Phase 22 |
| 2 | The documented v1/v2/v3→v4 schema-upgrade mechanism behaves as written (NV-2 mechanism evidence) | `e2e/migration.spec.ts` (3 tests, ordinary e2e suite; native versions 10/20/30 → 40; layouts from commits `b178c0d` / `5146264` / `de95c95`, all verified to exist in history); seeded via intercepted same-origin page, upgraded by the real app open path in real Chromium; audit §6 "Evidence upgraded in Phase 23" | **Synthetic** legacy databases (markers `NV23 …`, `example.invalid`) upgraded in real Chromium; snapshots are structured-cloned records compared with deep equality (not physical bytes); tripwire rows prove no spurious backfill | Synthetic (real browser) | Anything about **authentic** user data; byte-level storage equality; paths not seeded (e.g. exotic unknown stores) | Verified as mechanism evidence — NV-2 itself remains open |
| 3 | Same upgrade semantics at unit level | `src/data/db/database.test.ts` (`LegacyDatabaseV1/V2/V3`, `fake-indexeddb`), `src/data/db/database.ts` (v2 upgrade hook = bookkeeping only; v3/v4 additive; no downgrade) | v1→v2→v3→v4 chains in jsdom + `fake-indexeddb` | Synthetic (jsdom) | Real-browser storage behavior (covered separately by row 2); authentic data | Verified (synthetic layer) |
| 4 | Only a native-10 start exercises the v1→v2 hook; 20/30 start later; 40 is no historical upgrade | `database.ts:65-114` (hook attached to declared v2 only); `docs/nv2-authorized-validation.md` §5 step 2 table; pinned by row 2's tripwires | Test-title/assertion level distinction in the committed suites and the protocol's reporting rules | Synthetic + procedure | That any particular future authentic database sits at native 10 | Documented and test-pinned |
| 5 | NV-2's authentic-data path is unverified; a safe process exists for future validation | Audit §6 blocker row ("none has ever been obtained or inspected"); `docs/nv2-authorized-validation.md` (Phase 24: authorization/provenance gate, original-never-opened + disposable copy outside the tree, owner-confirmed copy consistency, exact origin incl. port, `indexedDB.databases()` before any versionless `open`, enforced+verified outbound network boundary with Playwright interception as supplement only, SW/extension/background accounting, hard stops, classes A/B/C kept separate, closure checklist requiring authentic v1→v2 exercise) | **Nothing was executed against real data.** The protocol is readiness documentation only | Procedure (no evidence) | That the migration works on authentic historical data; the runbook proves nothing about authentic data | **OPEN** — awaiting an authorized authentic database |
| 6 | Recovery restore survives a process crash (NV-1, context) | `e2e-crash/crash-durability.spec.ts` (`npm run test:crash`, dedicated CI job), audit §6 "Verified in Phase 21" | Supervised Chromium killed mid-restore-transaction; same-profile restart vs raw pre-crash snapshot | Synthetic fixtures in real browser | Migration behavior; hardware power-loss durability | Verified (closed Phase 21) |
| 7 | Repository gates pass on current `main` | CI on `3f20871` (single `CI` workflow — jobs Quality gates / E2E smoke / NV-1 crash durability; run created 2026-10-12T06:31:14Z, `completed/success`, run-level status re-verified live against the GitHub API in phase 25) | Full suites executed by CI on the merge commit | Executed checks | Any integrity guarantee beyond what the committed tests assert | Verified at audit time (will drift; re-check the run for any newer `main`) |

**Unresolved limitations (stated, not guessed):**

- No authentic historical database has been obtained or inspected for
  NV-2 in this project; the only unblock is an owner-authorized
  artifact (runbook §3/§9) — no amount of synthetic fixtures, CI
  passes or documentation substitutes for it.
- CSV contract coverage says nothing about files produced outside this
  application (row 1).
- The audit's line-number citations refer to commit `e36a899` and drift
  with later changes (audit §9.1).
- This matrix is documentation, not executable evidence; every row
  defers to the sources named in it.
