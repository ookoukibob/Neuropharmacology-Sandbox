# Repository data integrity audit

## 1. Audit metadata and methodology

| Item | Value |
| --- | --- |
| Audit date | 2026-10-10 |
| Audited commit | `e36a89990af6d04df989daf2f67b0c8291932f6e` (`main`, Phase 10) |
| Repository state at start | `main` = `origin/main` = `e36a899`, working tree clean |
| CI for the audited commit | GitHub Actions run 37969178157 (Quality gates + E2E smoke): completed / success |
| Scope | Audit-only (§"Explicitly out of scope" of the phase brief): no production, test, schema, or configuration changes in this commit |
| Phase type | Evidence-driven audit; reproductions used temporary synthetic fixtures and were deleted before commit |

**Methodology.**

1. **Documentation contracts read in full or by section:** `docs/provenance.md`,
   `docs/domain-model.md`, `docs/validation.md`, `docs/npsl-format.md`,
   `docs/testing.md` (inventory), `docs/recovery-backup.md` (§2–§10 structure and
   guarantees), `docs/decisions.md` (ADR-14/ADR-18), `docs/architecture.md`
   (data layer, roadmap).
2. **Code inspected (full reads):** `src/data/schemas/npsl.ts`,
   `src/data/mappers/records.ts`, `src/data/mappers/npslDocument.ts`,
   `src/data/db/database.ts`, `src/data/import/importPipeline.ts`
   (validation and warnings), `src/data/repositories/repository.ts`,
   `src/data/repositories/dexieDrugRepository.ts` (CRUD, import, export,
   recovery, quarantine), `src/data/recovery/format.ts` (bounds),
   `src/features/drug-library/DrugForm.tsx` (`buildInput`, `draftsFromDrug`,
   `storedProvenance`, `storedTargetMetadata`, `splitList`),
   `src/features/drug-library/DrugDetailView.tsx`, `src/features/drug-library/store.ts`,
   `src/features/import-export/csv/csvExport.ts`, `csvImport.ts` (mapping and
   assembly), `ImportPanel.tsx`, `ExportPanel.tsx`.
3. **Repository-wide pattern search** for reconstruction sites: object literals
   built from existing objects, `.map()` over targets/parameters, destructuring
   + rebuild, wholesale nested replacement, schema parse/strip/default behavior.
   All call sites of `updateDrug` (one production caller), `importLibrary`,
   `restoreRecoveryArchive`, `toStoredRecord`, `assembleDrug`,
   `assignTargetIds` were traced to their inputs.
4. **Existing tests used as primary evidence** (unit/integration/E2E listed per
   matrix row below).
5. **Temporary reproductions** (synthetic fixtures only, jsdom +
   `fake-indexeddb`, no real user data): seven focused tests, `R1`–`R7`,
   recording setup, assertion, and result in §5/§6. Assertions stated the
   documented/correct behavior, so a failure is the defect evidence. All
   reproduction code was deleted; the working tree contains only this report.
   One non-test probe: a `node -e` one-liner for JSON `-0` round-tripping.
6. **Gates:** `typecheck`, `typecheck:e2e`, `lint`, `test`, `build`,
   `test:e2e`, `git diff --check`, `npm audit --omit=dev` were executed locally
   on the audited revision (results in the phase report); CI results for this
   exact SHA were reused as corroboration only.

This report does **not** claim exhaustive proof of correctness. Every verdict
below names the evidence actually examined.

---

## 2. Executive summary

**Confirmed findings: 4** — 0 Critical · **2 High** · **1 Medium** · **1 Low**.
Of these, **4 are remediated (DI-01 in Phase 12, DI-02 in Phase 13, DI-03 in Phase 14, DI-04 in Phase 15)**;
**none remain open**.
**Coverage gaps: 4** (behavior plausibly correct, evidence inadequate) —
**3 closed**: GAP-1 and GAP-2 gained committed regression coverage in
Phase 16 (no production change was needed); GAP-3 was closed in Phase 17
with the documented policy that a Merge never overwrites a quarantined
row (blocking `QUARANTINE_CONFLICT` + preview advisory); **1 remains**:
GAP-4.
**Not verified: 3** (environment/asset blockers).

| ID | Severity | Confidence | One-line summary |
| --- | --- | --- | --- |
| **DI-01** | High | confirmed | Every `DrugForm` edit silently drops `identifiers.description` and `identifiers.casNumber` (partial `identifiers` replacement). Repro `R1`. **Remediated in Phase 12** — status details in §5. |
| **DI-02** | High | confirmed | NPSL import does not implement the documented blocking duplicate-`targets[].id` check; accepted files later cause silent provenance/metadata misattribution on ordinary edits. Repros `R2`, `R3`. **Remediated in Phase 13** — status details in §5. |
| **DI-03** | Medium | confirmed | The edit form silently normalizes *untouched* list/text fields: synonyms/tags are re-split at commas, trimmed and de-duplicated; names/notes are trimmed. Repro `R4`. **Remediated in Phase 14** — status details in §5. |
| **DI-04** | Low | confirmed | NPSL JSON round-trip cannot represent `-0` (stringifies to `0`), silently flipping value semantics and (second-order) restamping provenance of an untouched `-0` parameter; `.npsb` has a documented sidecar, `.npsl` has neither documentation nor handling. Node probe. **Remediated in Phase 15** — status details in §5. |

No Critical finding: recovery atomicity, import atomicity, and the quarantine
machinery behaved as documented in every path exercised (§4 F/G), and no path
was found that corrupts or destroys a library broadly.

**Documented lossy behavior explicitly NOT counted as findings** (contract and
user-visible warnings verified): CSV flattening and origin/timestamp re-stamping
(`docs/validation.md` §7, `ExportPanel.tsx:98-105`, `docs/testing.md:266-270`);
envelope-extra dropping and timestamp filling (`importPipeline.ts:242,259`);
replace-import clearing quarantined rows (disclosed by the replace
acknowledgement, `ImportPanel.tsx:451-467`, and covered by the recovery E2E
story, `docs/testing.md:195`); quarantine exclusion from exports
(`ExportPanel.tsx:82-90`).

---

## 3. Data-flow inventory

Boundaries where domain data is transformed, with the contract each crossing
claims. Verdict references point to §4 (matrix), §5 (findings), §6 (gaps).

| # | Boundary (code path) | What crosses | Key contract | Verdict |
| --- | --- | --- | --- | --- |
| 1 | Zod parse → domain: `records.ts` `fromRecord` (`records.ts:287`) over `npsl.ts` schemas | Stored raw row → `Drug`; all schemas are `z.looseObject` (`npsl.ts:14-31`) | Unknown keys kept at every level; invalid → quarantine, never repair | Pass (A2, G1) |
| 2 | Domain → stored row: `toRecord` (`records.ts:238`) + `toStoredRecord` (`records.ts:326`) + `preserveUnknownFields` (`records.ts:177`) | Recognized fields from domain; unknown fields copied from incoming drug + existing raw row (targets matched by stable id) | "A key in the contract is governed by the domain value; a key outside the contract is copied forward" (`records.ts:14-18`) | Pass at mapper level (A1); targets-replacing coverage committed (GAP-1 → **Phase 16**); **Finding** at the form boundary for contract keys (DI-01, remediated in Phase 12) |
| 3 | `DrugForm.buildInput` → `DrugChanges` (`DrugForm.tsx:246-306`, submit arg `DrugForm.tsx:407`) | name/synonyms/tags/notes/params/provenance/metadata → partial update object | 9A rule (`provenance.md:48-54`); Phase-10 metadata rule (`DrugForm.tsx:283-292`) | Pass (C1, B3); **Finding DI-01** (identifier fields) — **remediated in Phase 12**; **Finding DI-03** (list/text normalization) — **remediated in Phase 14** (mount-time baseline; untouched drafts submit source values verbatim) |
| 4 | `applyChanges` (`dexieDrugRepository.ts:93-106`) | Partial update over re-read current row inside transaction | Documented: "absent keys keep their value; structures replaced wholesale when present" (`repository.ts:67-72`) | Pass as a repository contract; only production caller is `DrugDetailView.tsx:109` |
| 5 | NPSL file → validated drugs: `parseNpsl` + `validateNpslFile` (`importPipeline.ts:247-310`) | Envelope, schema, semantic checks, warnings | `validation.md` §3–§4: duplicate drug ids AND duplicate `targets[].id` per drug are blocking | **Finding DI-02 → remediated (Phase 13)**: per-drug target-id check added to `validateNpslFile` |
| 6 | Import commit: `importLibrary` (`dexieDrugRepository.ts:258-309`) | `replace` = clear + write; `merge` = `get(id)` + `toStoredRecord(existing, file)` | Atomic in one transaction; invalid file → zero writes; merge does not touch metadata | Pass (D4, D6) |
| 7 | Domain → NPSL file: `toNpslDocument`/`serializeNpslDocument` (`npslDocument.ts:29-40`) | Full domain drugs incl. unknown fields riding from parse | "No field is invented or rewritten"; quarantined rows excluded with warning | Pass (D1, D9); **Finding DI-04 → remediated (Phase 15)**: the serializer now emits the numeric token `-0` (collision-proof placeholder), so the contract holds for the sign too |
| 8 | Domain → CSV: `csvExport.ts` (`drugLevelCells:123`, `targetCells:138`, `provenanceCells:100`, `rowsForDrug:149`) | 57 stable columns; provenance split into type/source/JSON cells; one row per target | Documented lossy projection with always-visible warning (`ExportPanel.tsx:98-105`) | Pass (E1–E4) |
| 9 | CSV → NPSL document: `csvImport.ts` (`assembleDrug:690`, target-id check `:649`) | New records, `origin: 'imported'` (`:703`) | CSV-specific validation incl. per-drug target-id uniqueness; origin re-stamp documented | Pass (E4, D5 contrast) |
| 10 | Storage → session: `getAllDrugs` (`dexieDrugRepository.ts:129-143`) + `store.hydrate`/`refresh` (`store.ts:122-150`) | Valid drugs + quarantine report + metadata | Failure ≠ empty library; quarantine never deleted | Pass (G1–G3) |
| 11 | `.npsb` export: `exportRecoveryArchive` (`dexieDrugRepository.ts:319-360`) | Raw valid + quarantined rows, raw meta, numeric sidecar | Fidelity contract `recovery-backup.md` §6 | Pass (F1–F5) |
| 12 | `.npsb` restore: `parseRecoveryArchive` → `restoreRecoveryArchive` (`dexieDrugRepository.ts:368-394`) | Verbatim raw rows, full replacement | Validate-before-write, atomic, four outcomes (`recovery-backup.md` §8) | Pass (F6–F8) |
| 13 | Preferences: `preferences/schema.ts:110-114` ↔ storage | `version + theme + calculator.settings` only | 9B: presentation state only, validated before apply | Pass (H1–H5) |
| 14 | Calculator session (`features/calculator/store.ts`) | Drafts, report, curve, `stale` flags (`:197-246`, `:288`) | Session/presentation only; never written to the library | Pass (H3, H5); multi-tab writes → GAP-4 |
| 15 | DB migration: `database.ts:33-43` v1→v2 upgrade hook | Backfills `persistenceVersion` + timestamps only | Bookkeeping-only, idempotent; never touches scientific/unknown fields | Pass (A6, fixture-based only → limitation) |

---

## 4. Coverage matrix

Verdicts: **Pass** = contract supported by implementation *and* adequate tests;
**Gap** = behavior maybe correct, evidence inadequate; **Finding** = defect with
code/reproduction evidence; **Not verified** = blocker stated.

### A. Domain types, schemas, object reconstruction

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| A1 | `toRecord`/`fromRecord`/`toStoredRecord`/`preserveUnknownFields` (`records.ts`) | Pass | `records.test.ts:24-173` (round trip, provenance triples, absent-optionals, quarantine, contract-key rules, target-id-not-position matching `:132`); extension matrix `dexieDrugRepository.test.ts:508-621` |
| A2 | Zod schema strictness/loose behavior (`npsl.ts`) | Pass | Full read: every object is `z.looseObject`; non-finite rejected (`records.test.ts:89`); wrong enum rejected (`records.test.ts:73`) |
| A3 | Recognized `DrugIdentifiers` fields across the **form edit** path | **Finding DI-01 → remediated (Phase 12)** | `DrugForm.tsx:248,407` builds `{name, synonyms}` only; `dexieDrugRepository.ts:99` replaces wholesale; `IDENTIFIER_KEYS` (`records.ts:91`) excludes them from copy-forward; repro `R1`. Fix: `buildInput` reattaches both fields from the stored record; regression tests in `views.test.tsx` (`DrugForm — identifier metadata preservation on edit`) and `DrugForm.persistence.test.tsx` (raw-row assertion) |
| A4 | `assignTargetIds` / `createDrug` reconstruction (`dexieDrugRepository.ts:82-89`) | Pass | Spread preserves all fields; id kept when present, `newId()` when empty; `TargetInput` widens only `id` |
| A5 | `applyChanges` partial-update semantics (`:93-106`) | Pass (contract) | Documented `repository.ts:67-72`; `tags`/`notes`/`origin`/`createdAt`/`persistenceVersion` verified intact on edit (repro `R1` raw-row assertion covered them); `pharmacokinetics` key absent from form input → untouched (code `:102`, repro `R6` pass) → GAP-2 closed with a committed PK round-trip test (Phase 16) |
| A6 | Migration hook (`database.ts:33-43`) | Pass | Hook adds only two bookkeeping keys via `modify`; `database.test.ts` migration test; limitation: fixture data only |
| A7 | Library-metadata mapping (`resolveLibraryMetadata`, `touchLibrary:413-419`) | Pass | `touchLibrary` spreads current row; metadata extensions carried in `dexieDrugRepository.test.ts:509` (`metadataExtras`) |
| A8 | Unknown-field survival under a **targets-replacing** update (form path) | **Resolved (Phase 16)** — committed regression coverage, no production change needed | Repository: `dexieDrugRepository.test.ts` GAP-1 describe (import baseline, reordered same-id replacement, removal/new-id non-transfer); form: `DrugForm.persistence.test.tsx` GAP-1 test (real detail → edit → save, `changes.targets` supplied wholesale as the form always does). Both fail when stable-id matching in `preserveUnknownFields` is deliberately broken; `R5` local experiment reproduced in committed form |

### B. Drug create, edit, delete workflows

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| B1 | Create flow | Pass | `views.test.tsx:231` safeguards describe; `store.test.ts:130`; invalid creation leaves state untouched `:147` |
| B2 | Edit: name, synonyms, tags, notes, description, CAS | **DI-01 remediated (Phase 12); DI-03 remediated (Phase 14)** | `R1`, `R4`; detail view displays description/CAS at `DrugDetailView.tsx:141-145` (loss was user-visible after save; now preserved per A3 regression tests); untouched list/text values now survive verbatim (§5 DI-03 status) |
| B3 | Target add/remove/rename, stable identity, ID assignment | Pass | Phase 10 suite `views.test.tsx:636-` (8 tests), `DrugForm.persistence.test.tsx` (2), E2E `e2e/library.spec.ts:197`; removal/position-shift and remove-recreate covered |
| B4 | Parameter add/remove, unit change, kind change | Pass | `views.test.tsx:231` (unit/dimension guards), `:394` (9A provenance describe); kind-substitution impossible by construction (separate named fields, `drug.ts:39-58`) |
| B5 | Read-only/origin gating | Pass | `DrugDetailView.tsx:116,226`; only `origin === 'user'` editable; `updateDrug` has exactly one production caller (traced) |
| B6 | Pharmacokinetics preservation on unrelated edit | **Resolved (Phase 16)** — committed regression coverage, no production change needed | Code `dexieDrugRepository.ts:102` (key-absent → untouched); `DrugForm.persistence.test.tsx` GAP-2 test deep-equals the whole stored `pharmacokinetics` object (values, units, complete provenance incl. unknown extension key) against the fixture in the raw row and in a fresh repository read after a form-driven rename; fails if PK is reset or rebuilt (`applyChanges` break verified); `R6` local experiment reproduced in committed form |
| B7 | Delete flow | Pass | `store.test.ts:164,186`; E2E `e2e/library.spec.ts:63` |
| B8 | Repository `targets` replacement semantics | Pass | `applyChanges:101` + `assignTargetIds`; contract documented `repository.ts:71` |

### C. Scientific values and provenance

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| C1 | Unchanged value keeps complete provenance (9A) | Pass | Policy `provenance.md:48-54` ("complete object, all fields, unknown extension keys included"); code `DrugForm.tsx:267-277`; `views.test.tsx:394-` describe; persistence test asserts `syntheticExtension` rides through an unrelated edit |
| C2 | Changed value → fresh `user` stamp; never upgraded | Pass | `DrugForm.tsx:277` (only ever `{type:'user', recordedAt}`); no code path constructs `literature`/`calculated`/`derived`; import writes provenance *as declared in the file* (documented `provenance.md` §2) |
| C3 | No `Kd`/`Ki`/`EC50`/`IC50` substitution | Pass | Separate named fields (`drug.ts:39-58`); unit-dimension checks per kind (`importPipeline.ts:120-145`); form validation `views.test.tsx:231` |
| C4 | Removing/changing one parameter does not transfer another's provenance | Pass (import-time id collisions now blocked — DI-02 remediated in Phase 13; pre-existing stored collisions remain, see §5 DI-02) | Per-target-id, per-kind lookup (`DrugForm.tsx:118,257-263`); removal + distinctness tests in `views.test.tsx:394,636`; the colliding-id exception required a file the import now rejects |
| C5 | Unknown provenance fields through import → storage → form edit → raw row | Pass | Mapper level `records.test.ts:107-173`; repository matrix `dexieDrugRepository.test.ts:495-506`; form path via persistence test |
| C6 | CSV provenance flattening disclosed | Pass | `csvExport.ts:100-111` (type/source/JSON cells), warning `ExportPanel.tsx:98-105`, `validation.md` §7, `docs/testing.md:266-270` |
| C7 | Numeric formatting / value semantics (`-0`) | **Remediated (Phase 15)** — exact preservation: serializer emits the JSON token `-0`, import stores the parsed sign, and the form's draft-text identity rule keeps an untouched `-0` (and its provenance) through edits | Original defect evidence: `JSON.stringify(-0) === "0"` (node probe); schema accepts `-0` (finite), `npsl-format.md` now documents the `-0` contract; NPSB documents the same JSON problem and sidecar (`recovery-backup.md:377-386`); form path `String(-0) === "0"` → `Object.is(-0, 0) === false` used to restamp an untouched parameter — see §5 DI-04 status |
| C8 | Provenance attribution under identity ambiguity | **Finding DI-02 → remediated at import (Phase 13)** — collision-causing files are rejected before storage; already-stored ambiguous libraries remain out of scope | Repro `R3`: unchanged literature value replaced by fresh user stamp after an unrelated rename; map is last-wins by target id; input for `R3` now fails validation |

### D. NPSL import and export

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| D1 | Valid-record round trip (domain → file → domain) | Pass | `records.test.ts`, `dexieDrugRepository.test.ts:640-646` (export → re-import identity), `importPipeline.test.ts` |
| D2 | Unknown-field preservation across import → storage → export → re-import | Pass | Extension matrix `dexieDrugRepository.test.ts:508-621` (replace, merge, hydration, edit, export, re-import, rollback); `npsl.ts:14-31` documents the contract |
| D3 | Envelope extras / timestamp filling disclosed | Pass | `ENVELOPE_FIELDS_DROPPED` (`importPipeline.ts:242`), `TIMESTAMPS_FILLED` (`:259`), warning UI test in `ImportPanel` suite |
| D4 | Duplicate drug ids blocking; invalid input writes nothing | Pass | `importPipeline.ts:251-279`; `store.test.ts:268,285`; validation runs inside the transaction before any write (`dexieDrugRepository.ts:270-274`) |
| D5 | Duplicate `targets[].id` per drug | **Remediated (Phase 13)** | `validation.md:97` promises blocking `DUPLICATE_ID`; `importPipeline` `seenIds` was drug-level only (repro `R2`: `report.ok === true`); CSV path *does* check (`csvImport.ts:649`); fix adds the per-drug check to `validateNpslFile` (commit `db3c75e`), CSV behavior unchanged |
| D6 | Merge/replace semantics; mid-write failure rollback | Pass | Atomic transaction (`:270-308`); `store.test.ts:309,331`; merge metadata untouched (`:296-297`) |
| D7 | Replace import vs quarantined rows | Pass (documented loss) | `drugs.clear()` (`:279`) removes quarantine; replace acknowledgement `ImportPanel.tsx:451-467` ("permanently overwrites every existing record"); recovery story tested `docs/testing.md:195` + E2E `recovery.spec.ts` |
| D8 | Preview conflict disclosure | Pass (GAP-3 resolved, Phase 17) | Conflict count from hydrated valid drugs only (`ImportPanel.tsx:187,207`); quarantined-id collisions are now surfaced by the preview advisory `preview-quarantine-conflicts` (`ImportPanel.tsx`) while the authoritative block runs inside the repository transaction — a stale preview cannot bypass it (`ImportExportView.test.tsx` GAP-3 tests) |
| D9 | Quarantined rows excluded from export, visibly warned | Pass | `exportLibrary` comment `:314`; `ExportPanel.tsx:82-90` ("not a complete backup"); UI test `docs/testing.md:311` |
| D10 | `.npsl`/`.npsb` mutual rejection | Pass | `docs/testing.md:324` (E2E), `recovery-backup.md:902`, `importLibrary` on `.npsb` → `SCHEMA`/`PARSE`, zero writes |

### E. CSV and other lossy conversions

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| E1 | Header stability, escaping, formula guard, Unicode | Pass | `csvExport.ts:4-57` (stable header derived from `CSV_PARAMS`), `writeCsv.test.ts`, `validation.md` §7 |
| E2 | Zero-target drug export | Pass | `rowsForDrug` emits one row (`csvExport.ts:149-152`); documented `validation.md` §7 |
| E3 | Warning accuracy vs actual loss | Pass | `ExportPanel.tsx:98-105`: flattening, JSON provenance cells, unknown-field drop, and "CSV is not a substitute" all match observed behavior; target-level unknown fields are *not* in CSV (contract columns only, `csvExport.ts:57-78`) and are covered by the warning's "drops fields the current schema does not know" |
| E4 | Re-import implications (origin/timestamps/target ids) | Pass (documented) | `csvImport.ts:703` sets `origin: 'imported'`; `docs/testing.md:266-270` and `validation.md:218,230-232` disclose origin re-stamp, timestamp derivation, and fresh target ids |
| E5 | Exhaustive per-column round trip of all 57 columns | Not verified (NV-3) | Core value/unit/provenance columns tested (`docs/testing.md:267-268`); line-by-line enumeration of every column's test was not performed |

### F. NPSB recovery backup and restore

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| F1 | Valid + quarantined + unknown-field rows included | Pass | `exportRecoveryArchive` (`:319-360`), `archive.ts` classification (`:129-204`), `store.test.ts:394-423`, E2E quarantine round trip (`docs/testing.md:324`) |
| F2 | Metadata rows + stable keys + verbatim raw rows | Pass | Restore writes raw rows with no re-validation (`:375-392`); key/id equality proven in validation (`archive.ts:469-474` region) |
| F3 | Numeric sidecar (`-0`, `NaN`, ±∞) | Pass | `recovery-backup.md:375-427` (rules, placeholders, preconditions); `fidelity.ts`, `fidelity.test.ts` |
| F4 | Serialization fidelity checks and failure modes | Pass | `fidelity.ts` (UTF-8 byte counting `:71-96`, depth `:201-208`), `fidelity.test.ts`; `ARCHIVE_VALUE_DOMAIN` for unannotated special numbers (`recovery-backup.md:416-423`) |
| F5 | Duplicate-key detection and input bounds | Pass | `duplicateKeys.ts` + test; bounds `format.ts:20-24` (64 MB, 100 000 drug rows, 1 000 meta rows, 1 000 000 annotations, depth 100) |
| F6 | Read-only preview; validation before write; atomic full replacement; rollback | Pass | `previewRecoveryArchive` (`:362-366`) parses only; `restoreRecoveryArchive` validates fully before the transaction (`:368-373`); single `rw` clear+rewrite (`:383-392`); failure tests `store.test.ts:431,451` |
| F7 | Four outcomes; retry cannot double-restore | Pass | Store outcome types (`store.ts:71-111,232-262`); committed-refresh-failed keeps state stale and offers *refresh* retry (`store.test.ts:474`, component test, `docs/testing.md:308`) |
| F8 | Version/compatibility and reclassification | Pass | Version validation in `archive.ts`; classification mismatches are warnings, rows "restored verbatim either way" (`archive.ts:635-639`, `recovery-backup.md:630-653`) |

### G. Quarantine, hydration, migrations

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| G1 | Invalid records surfaced, never deleted | Pass | `getAllDrugs` pushes to quarantine with raw record (`dexieDrugRepository.ts:129-143`); `store.test.ts:42` |
| G2 | Hydration failure ≠ empty library | Pass | `store.test.ts:88` ("surfaces repository failures as an error state"); error path sets `status:'error'` |
| G3 | Valid records unaffected by an invalid sibling | Pass | Loop continues past invalid rows; `store.test.ts:42` |
| G4 | Repeated load/refresh/import/retry | Pass | In-flight hydrate guard `store.test.ts:60`; invalid/duplicate imports leave library unchanged `:268,285`; committed-refresh-failed retry semantics `:331,474` |
| G5 | Merge import vs a colliding quarantined row | **Resolved (Phase 17)** | Policy decided: protection wins — a merge id colliding with a row the hydration classifier quarantines is a blocking `QUARANTINE_CONFLICT` raised inside the import transaction before any write (`dexieDrugRepository.ts` merge pre-scan via `fromRecord`); quarantined row stays byte-identical and in the quarantine report; preview advisory names the ids but the transaction is the integrity boundary; contract ambiguity resolved (`repository.ts` `ImportMode` docs, `validation.md` §4/§5, `npsl-format.md` §6, ADR-15); committed tests in `dexieDrugRepository.test.ts` + `ImportExportView.test.tsx` |
| G6 | v1→v2 migration information preservation | Pass (fixture-based) | See A6; no real-world corpus available → limitation |

### H. Calculator and application preferences

| Row | Path | Verdict | Evidence examined |
| --- | --- | --- | --- |
| H1 | Preferences contain documented presentation state only | Pass | `preferences/schema.ts:110-114` (`version`, `theme`, `calculator.settings`); schema tests |
| H2 | Reset cannot clear/modify drug records | Pass | `SettingsPage.test.tsx:211,241` ("reset never touches scientific data or calculator drafts"), `preferences/store.test.ts:226,244` |
| H3 | No drafts/reports/curve/provenance in preference persistence | Pass | `preferences/store.test.ts` persistence-shape tests; calculator state lives in `features/calculator/store.ts` (never written to library) |
| H4 | Saved settings validated before applying | Pass | Zod parse + engine cross-checks (`preferences/schema.ts`), 9B tests |
| H5 | Applied curve settings never falsify scientific inputs or freshness | Pass | `applyPresentationSettings` (`calculator/store.ts:288`) does not touch drafts/report; stale flagging tests `store.test.ts:642-682`; UI notice `VisualizationPanel.test.tsx:126` |
| H6 | Cross-tab preference/concurrency behavior | Not verified (folded into GAP-4) | No multi-tab tests exist; preferences are presentation-only so the risk was assessed as negligible, not proven |

---

## 5. Confirmed findings

### DI-01 — Form edit silently drops `identifiers.description` and `identifiers.casNumber`

> **Status: remediated — Phase 12** (`fix: preserve identifier metadata during drug edits`).
> The fix lives in `DrugForm.buildInput`: `description`/`casNumber` are reattached from the
> stored record with conditional spreads — present keeps its exact stored value, absent
> stays absent (omitted, never an explicit `undefined`), nothing is synthesized — while
> `name`/`synonyms` keep coming from form state and create mode is unchanged.
> Regression evidence: form-level tests in `src/features/drug-library/views.test.tsx`
> (describe `DrugForm — identifier metadata preservation on edit`) plus the real-repository
> test in `src/features/drug-library/DrugForm.persistence.test.tsx` (“keeps identifiers
> description and CAS in the raw row after an unrelated edit”), which asserts the raw
> IndexedDB row before any mapper runs. The original defect description and reproduction
> `R1` below are retained unchanged as the audit trail.

| Field | Value |
| --- | --- |
| Severity | **High** (silent loss of supported user data through a supported workflow) |
| Confidence | **confirmed** (code path + reproducible failure `R1`) |
| Location | `src/features/drug-library/DrugForm.tsx` `buildInput` (`:246-306`, identifiers parameter `:248`, submit argument `:407`); consumed by `src/data/repositories/dexieDrugRepository.ts` `applyChanges` (`:99`) |
| Transformation | Stored `Drug` → form state → `DrugInput.identifiers = { name, synonyms }` (partial) → `draft.identifiers = changes.identifiers` (wholesale replacement) → `toRecord` emits only the domain value; `preserveUnknownFields` cannot help because `description`/`casNumber` are **contract** keys (`IDENTIFIER_KEYS`, `records.ts:91`) governed by the domain value (`records.ts:14-18`) |
| Reproduction `R1` | Seed `origin:'user'` record with `description: 'Synthetic description — audit fixture.'`, `casNumber: 'SYNTH-CAS-001'`; render detail (both fields visible, `DrugDetailView.tsx:141-145`); click edit; rename; submit. **Result:** raw row `identifiers` = `{ name: 'Audit Renamed', synonyms: ['AF'] }` — assertion `expected {name, synonyms} to deeply equal {name, synonyms, description, casNumber}` failed; fresh `getDrug` confirms both fields gone |
| Actual vs intended | Actual: fields deleted on any edit. Intended: `docs/domain-model.md` §4 defines both fields as part of the aggregate; `npsl.ts:159-160` serializes them; the NPSL round-trip contract (`npsl.ts:14-31`) promises recognized-field preservation |
| Data affected / conditions | `description` and `casNumber` on any form-editable record (`origin:'user'`) that carries them — reachable by NPSL import of a file declaring `origin:'user'`, or `.npsb` restore of such rows. Trigger: **any** edit (name, tag, note, target, parameter) |
| Loss character | **Silent** (field visibly disappears from the detail view only after saving); recoverable only from an external source (original import file or `.npsb` backup) |
| Suggested remediation boundary | `DrugForm.buildInput` only: reattach `description`/`casNumber` from `original` with per-key conditional spreads (the exact Phase-10 pattern used for `storedTargetMetadata`), absent stays absent. No repository/schema/UI change needed |
| Proposed regression tests | Form test: unrelated edit keeps both fields (raw-row assertion); create mode still emits neither; absent stays absent; persistence-level test through the real repository |
| Fix dependencies/risks | None external. Risk: accidental resurrection of user-*cleared* values — mitigated because there is no UI editor for these fields (clearing is currently impossible); must not add metadata editing UI |

### DI-02 — NPSL import accepts duplicate `targets[].id`, causing later provenance/metadata misattribution

> **Status: remediated — Phase 13** (commit `db3c75e`,
> `fix: reject duplicate target ids in NPSL imports`).
> The semantic layer of `validateNpslFile` now counts `targets[].id` **per drug** —
> exact string comparison, no normalization; the same id in a *different* drug stays
> legal (uniqueness is per drug, per `validation.md:97` and `domain-model.md:119`) —
> and emits a blocking `DUPLICATE_ID` issue naming the drug, the duplicated id and the
> path `drugs.<index>.targets`. The check runs in the preview path and is re-run inside
> `importLibrary`'s existing transaction before the first write, so a violating
> document — mixed valid/invalid alike — commits nothing (the established all-or-nothing
> semantics; no new transaction layer). Schema validation still owns malformed ids: the
> NPSL schema requires every target `id` to be ≥ 1 char, so a missing/empty id surfaces
> as `SCHEMA`, never as a duplicate.
> Regression evidence: `src/data/import/importPipeline.test.ts` (describe
> `validateNpslFile — target id identity (unique per drug, blocking)`: rejection with
> message/path, distinct-ids acceptance, cross-drug same-id acceptance, schema authority
> for missing/empty ids, mixed-document rejection, preview reporting — the three
> rejection tests verified to fail against the pre-fix code with `ok: true`, the exact
> `R2` signature) and `src/data/repositories/dexieDrugRepository.test.ts` (“rolls back:
> duplicate target ids inside one drug leave every stored row byte-identical”: raw-row
> and metadata snapshots unchanged, stored provenance/target notes intact, the valid
> record from the same rejected file absent — also verified to fail pre-fix). The
> original defect description and reproductions `R2`/`R3` below are retained unchanged
> as the audit trail. **Out of scope (unchanged):** libraries that already stored
> duplicate target ids keep working but remain ambiguous — no stored id is rewritten.

| Field | Value |
| --- | --- |
| Severity | **High** (silent misattribution of provenance and target metadata through a supported workflow: import, then ordinary edit) |
| Confidence | **confirmed** (documentation promises the check; code lacks it; downstream corruption reproduced) |
| Location | `src/data/import/importPipeline.ts` `validateNpslFile` (`:251-279`: `seenIds` counts **drug** ids only; `DUPLICATE_ID` emitted at `:274`); documented requirement `docs/validation.md:97` ("unique `targets[].id` per drug → error `DUPLICATE_ID` — blocking"); domain invariant `docs/domain-model.md:119`. Contrast: the CSV path enforces it (`csvImport.ts:649`) |
| Transformation path | File with two targets sharing one id → accepted with **zero warnings** → stored → `DrugForm.storedProvenance` (`DrugForm.tsx:118`) and `storedTargetMetadata` (`:148`) build maps keyed by target id (last target wins) → every row with that id resolves the *same* stored state; `records.ts:177` `preserveUnknownFields` matches the *first* previous target with that id |
| Reproduction `R2` | NPSL text with one drug, targets `DUP-A` (kd 1 nM, literature) and `DUP-B` (kd 2 nM, user), both id `dup-target-1`. Asserted documented outcome: `report.ok === false` with `DUPLICATE_ID`. **Result:** `expected true to be false` — import returned `ok: true` and wrote the record |
| Reproduction `R3` | After `R2`'s import: rename the drug via the form (no parameter touched). Asserted: target A keeps `{type:'literature', ...}`. **Result:** `expected {type:'user', …} to deeply equal {type:'literature', …}` — A's unchanged value received a **fresh user stamp** (B's provenance state was consulted, values differed → restamp). Test output also shows React's `Encountered two children with the same key, "dup-target-1"` — duplicate ids additionally break list identity in the UI |
| Actual vs intended | Actual: spec-violating files import silently and corrupt attribution on later edits. Intended: blocking `DUPLICATE_ID` before any write (`validation.md` §4), mirroring the CSV check |
| Data affected / conditions | Provenance of every parameter on every target sharing the id (literature → user restamp with no user action); `gene`/`action`/`species`/`notes` misattached across targets (Phase-10 maps); unknown extension fields transplanted to the first match. Condition: any `.npsl` file containing a duplicated target id inside one drug |
| Loss character | **Silent** (no import warning); the original provenance survives only in the source file/backup; irreversible in-place |
| Suggested remediation boundary | One semantic check in `validateNpslFile`: per-drug `seen` set of target ids → error `DUPLICATE_ID` (blocking, zero writes), plus a test asserting rejection *and* a test asserting no misattribution on a valid file with equal target names/ids |
| Proposed regression tests | `importPipeline.test`: duplicate target id → `DUPLICATE_ID`, `ok:false`; repository test: rejected import leaves storage unchanged; regression: unchanged-value provenance preserved with multiple targets (already covered — keep green) |
| Fix dependencies/risks | Files that previously imported against the documented contract will become un-importable (intended, but changes user-visible behavior for such files); stored libraries already containing duplicate target ids keep working but remain ambiguous — remediation does not attempt to rewrite stored ids |

### DI-03 — Untouched list/text fields silently normalized on every save

> **Status: remediated — Phase 14** (commit `5283799`,
> `fix: preserve untouched drug list and text fields`).
> Fix boundary: `DrugForm` only. A mount-time baseline captures the stored
> source values (`identifiers.name`, `identifiers.synonyms`, `tags`, top-level
> `notes`) plus each field's initial draft text; at submit a draft still equal
> to that baseline — compared as *text*, never re-parsed — submits the source
> value **verbatim**: array order, duplicate entries, embedded commas, and
> leading/trailing whitespace inside entries and inside name/notes all survive,
> and the `notes` present/absent distinction is kept (an explicitly empty string
> stays present, an absent field stays absent). Only a field the user actually
> changed follows the established policy: lists are comma-split, trimmed and
> de-duplicated (`splitList`), name and notes are trimmed; a draft edited and
> reverted to its exact initial text counts as unchanged. Create mode is
> untouched (no baseline exists; the existing normalization applies).
> **Known limitation:** the comma-delimited inputs cannot represent an individual
> list entry containing a comma *while that list is being edited* — such an
> entry survives untouched, but editing the list re-splits it; no escaping
> syntax or new widget was added (documented in `validation.md` §4 and the
> `DrugForm` module comment). **Regression evidence:**
> `src/features/drug-library/views.test.tsx` (describe
> `DrugForm — untouched list/text preservation on edit`: comma/duplicate round
> trip, padded name/notes byte-for-byte, unrelated edit, edited-field
> parse/trim policy, revert-to-baseline, absent/empty notes — six of the eight
> verified to fail against the pre-fix code with the `R4` signature; the other
> two are contract guards) and `DrugForm.persistence.test.tsx` (“keeps untouched
> list and text fields byte-identical in the raw row after an unrelated edit”:
> raw-row and fresh-read assertions alongside the DI-01/Phase-10/9A checks —
> also verified to fail pre-fix). The original defect description and
> reproduction `R4` below are retained unchanged as the audit trail.
> **Out of scope (unchanged):** target-name trimming inside `validate` (identity
> for duplicate-name checking; not part of `R4`); the comma-delimited list
> widget itself; target-level `notes` remain governed by the Phase-10 metadata
> rule, untouched here.

| Field | Value |
| --- | --- |
| Severity | **Medium** (partial loss under a narrower condition — entries containing commas/duplicates or edge whitespace — with an avoidable trigger) |
| Confidence | **confirmed** (repro `R4`) |
| Location | `src/features/drug-library/DrugForm.tsx`: `splitList` (`:52`), submit arguments (`:407-408`), `buildInput` notes trim (`:304`), name trim (`:407`) |
| Transformation | Stored arrays → `join(', ')` for display (`draftsFromDrug`, `:94`) → `split(',')` + trim + `Set` dedupe on submit; notes/name `.trim()` on every save regardless of which field the user changed |
| Reproduction `R4` | Drug with `synonyms: ['Alpha,Beta', 'X', 'X']`, `tags: ['one,two']`; render `DrugForm`, submit **without touching anything**. **Result:** `expected [ 'Alpha', 'Beta', 'X' ] to deeply equal [ 'Alpha,Beta', 'X', 'X' ]` — re-split **and** de-duplication; tags transform analogously |
| Actual vs intended | Actual: arrays are lossily re-derived on every save. Intended: no documented normalization; `npsl.ts` schemas pass arrays through verbatim (import/export preserve commas and duplicates — so the form is the only transformer, and it contradicts the "recognized-field preservation" contract for data the user never edited) |
| Data affected / conditions | Synonyms/tags containing `,` (possible via NPSL import; CSV `; `-separated lists can contain commas) or intentional duplicates; leading/trailing whitespace in stored names/notes. Condition: any edit of the record |
| Loss character | **Silent** and irreversible after save (original strings survive only in a backup/import source) |
| Suggested remediation boundary | `DrugForm` only: keep raw stored arrays and emit them unchanged unless the specific field was edited by the user (dirty tracking per field), or adopt a round-trip-safe list encoding. Product decision required on trim policy for the *edited* name/notes field |
| Proposed regression tests | Untouched synonyms/tags survive byte-identical (commas, duplicates, whitespace); editing the list applies the new policy deliberately; create mode unchanged |
| Fix dependencies/risks | UI displays comma-joined lists — a delimiter change is user-visible; needs an explicit product decision before implementation |

### DI-04 — `-0` does not survive the NPSL round trip (undocumented)

> **Status: remediated — Phase 15** (commit `fb28382`,
> `fix: preserve negative zero in NPSL round trips`).
> Policy: **exact preservation** — no normalization, no rejection, no
> sidecar, no format/schema version bump. JSON's number grammar includes
> the token `-0` (the loss was JavaScript serialization behavior, not a
> format prohibition), so only two lossy code paths needed fixing.
> Boundaries fixed: (1) `serializeNpslDocument` (`npslDocument.ts`) —
> plain `JSON.stringify` canonicalizes `-0` to `0`; it now tags every
> negative-zero number (recognized scientific values **and** unknown
> extension fields/arrays alike) with a NUL-delimited placeholder string,
> proves the placeholder's exact JSON literal absent from the untagged
> serialization first (collision-proof: an unproven match extends the
> placeholder until absent), and rewrites only those positions back to
> the numeric token `-0`. `.npsl` and `.json` exports and the CSV→NPSL
> preview text share this single serializer; output for documents
> without `-0` is byte-identical to the previous implementation.
> (2) `DrugForm.buildInput` — the input displays `-0` as `"0"`
> (`String(-0)`); a value draft still reading the source's own textual
> representation (`String(previous.value)`, matched by stable target id
> + parameter kind, never by re-parsing) now submits the stored number
> verbatim instead of `Number(draft)`, so an untouched `-0` keeps both
> its sign and its complete stored provenance — no more `Object.is`
> mismatch → user restamp. Any other draft text remains a user change
> under the existing rules, and the `Object.is` provenance policy itself
> is unchanged (no global ±0 equivalence).
> Regression evidence: `src/data/mappers/npslDocument.test.ts` (new:
> token emission, `JSON.parse` + `Object.is` round trip, +0/nonzero
> controls, multiple `-0` instances in one document, look-alike strings
> never rewritten, nested unknown-field object/array `-0`, byte-stable
> no-`-0` output, NaN/Infinity still rejected at the schema boundary —
> three of six verified to fail against the pre-fix serializer),
> `dexieDrugRepository.test.ts` ("imports literal -0 tokens, exports
> them verbatim and re-imports them exactly": hand-written document text
> with a literal `-0` token → import → raw-row `Object.is` → export
> token count → re-import → provenance identity — also failed pre-fix),
> `views.test.tsx` (describe `DrugForm — negative-zero parameter
> preservation on edit`: untouched `-0` + complete provenance, +0
> control, explicit-change restamp, cross-target isolation — two failed
> pre-fix) and `DrugForm.persistence.test.tsx` ("keeps a negative-zero
> parameter and its provenance exact in the raw row after an unrelated
> edit": form-driven save, raw-row `Object.is` + fresh read — failed
> pre-fix — plus the notes absent/empty own-property checks that close
> the DI-03 persistence evidence gap). Pre-fix total: seven regression
> tests failed with the documented signature (`"value": 0` on export;
> `+0` + fresh user stamp from the form). Phase 16 added the
> collision-branch test: source data containing the initial placeholder
> marker itself (as an extension value *and* as an extension property
> key) plus the first extended candidate forces the placeholder loop to
> advance twice; after `JSON.parse`, every marker-like string/key is
> byte-identical, both `-0` positions stay `Object.is(-0)`, and
> unrelated fields are untouched (verified to fail when the loop is
> capped at a single extension). The ordinary-fixture assertion was
> corrected from a meaningless raw-NUL check (JSON escaping means a
> leaked placeholder never appears as a literal NUL) to absence of the
> marker's distinctive text — fixtures that legitimately contain
> marker-like data are covered by the collision test instead. The
> original DI-04
> description and node-probe evidence below are retained unchanged as
> the audit trail. **Out of scope (unchanged):** the `.npsb` numeric
> sidecar (`recovery-backup.md` §6.3 — its `-0` restore precondition
> already accepts a literal `-0`, so it stays idempotent); CSV export
> remains the documented lossy projection.

| Field | Value |
| --- | --- |
| Severity | **Low** (value-semantic change of a numerically equal value; narrow trigger) |
| Confidence | **confirmed** (node probe + code paths) |
| Location | NPSL serialization (standard `JSON.stringify` in `npslDocument.ts:39` and file writers); schema accepts `-0` (`npsl.ts` `z.number().finite()`); form read/write `DrugForm.tsx:262` (`Number`) with `String(-0) === '0'` |
| Transformation | Stored `-0` → export writes `0` → re-import stores `0`; separately, a later form edit parses the displayed `0` and `Object.is(-0, 0) === false` classifies the parameter as *changed* → fresh user stamp (`DrugForm.tsx:272-277`) |
| Evidence | Node probe: `JSON.stringify(-0)` → `"0"`; `Object.is(JSON.parse('0'), -0)` → `false`. NPSB explicitly documents this exact JSON defect and solves it with a sidecar (`recovery-backup.md:377-386`); `npsl-format.md:92` states only "finite number; NaN/Infinity rejected" — `-0` is neither documented nor handled |
| Actual vs intended | Actual: silent `-0`→`0` flip on export; provenance restamp of an untouched `-0` parameter on later edits. Intended: undefined for NPSL — the asymmetry with NPSB's sidecar shows the issue was known for archives but never ruled in/out for NPSL |
| Data affected / conditions | Parameter values stored as `-0` (enterable via the form's `Number('-0')` or an NPSL file containing a literal `-0`). Note: `NaN`/±∞ cannot enter — schema rejects them at import (blocking) and on read (quarantine), `records.test.ts:89` |
| Loss character | Silent; numerically equal (scientifically inert for concentrations) but `Object.is`-observable, which this codebase uses for change detection |
| Suggested remediation boundary | Documentation-first: state `-0` behavior in `docs/npsl-format.md`; optionally normalize (`Object.is(v,-0)` → `0` at import with a `TIMESTAMPS_FILLED`-style warning) or reject `-0` in the schema — either is a self-contained schema/docs phase |
| Proposed regression tests | Round-trip test for the chosen policy (normalize-or-reject); form edit of `-0` does not restamp provenance if normalized |
| Fix dependencies/risks | Normalizing at import changes stored values for affected files (needs a warning); rejecting is stricter than today |

---

## 6. Coverage gaps and unverified paths

A missing test alone is not a defect; each gap below states what the code
*appears* to do and why that is insufficient evidence.

| ID | Area | What the code does (inspected) | Why it is a gap | Local experiment |
| --- | --- | --- | --- | --- |
| **GAP-1** | Unknown extension fields under a **targets-replacing** update (`records.ts:177` + `applyChanges:101`) | `toStoredRecord(existing, next)` re-attaches unknown keys from the raw row, targets matched by stable id | **Resolved (Phase 16)** — was: the committed "editing an unrelated known field" test only sent `{notes}`, so the wholesale-replacement path had no committed extension test | `R5` passed locally; now committed: `dexieDrugRepository.test.ts` describe `GAP-1 — unknown target extensions under a targets-replacing update (audit)` (import baseline → reordered same-id replacement + unrelated edit → per-position raw-row asserts; removal + new-id non-transfer boundary with the removed target's fields asserted absent from the whole row) plus the form-path test in `DrugForm.persistence.test.tsx` (real detail → edit → save where the form always submits a replacement `targets` array). Both fail when the stable-id match in `preserveUnknownFields` is deliberately broken |
| **GAP-2** | `pharmacokinetics` values under unrelated edits (`applyChanges:102`) | Key absent from form input → PK never replaced | **Resolved (Phase 16)** — was: no committed assertion on PK *values* (only the PK extension via `expectDrugExtensions`) | `R6` passed locally; now committed: `DrugForm.persistence.test.tsx` GAP-2 test seeds all four PK parameters (half-life, clearance, Vd, bioavailability) with units and complete provenance incl. an unknown extension key, performs an unrelated rename through the real form, then deep-equals the whole stored `pharmacokinetics` object against the fixture in the raw IndexedDB row and in a fresh repository read; fails if `applyChanges` drops or rebuilds PK |
| **GAP-3** | Merge import over a colliding **quarantined** row (`dexieDrugRepository.ts:291-292`) | `get(id)` returns the raw quarantined row; `put` overwrote it with the valid incoming record; the row silently left the quarantine report | **Resolved (Phase 17)** — was: undisclosed (preview conflict count comes from hydrated valid drugs only, `ImportPanel.tsx:187`), untested, and contract-ambiguous: "incoming wins per id" (`repository.ts:83`) vs the quarantine-preservation intent (`records.ts:12-13`); not labeled a defect because the documented quarantine contract covered hydration, export, and `.npsb` only — this path had never been ruled in or out. Decision: **protection wins**; documented in `validation.md` §4/§5, `npsl-format.md` §6, `decisions.md` ADR-15, `repository.ts` `ImportMode` | `R7` **recorded the pre-fix behavior**: quarantine list lost the id; valid list gained it; import reported `ok`. Now committed: `dexieDrugRepository.test.ts` describe `DexieDrugRepository — merge import vs a quarantined row (audit GAP-3)` (rejection with `QUARANTINE_CONFLICT`, raw row byte-identical incl. unknown extension, whole-document no-write with metadata untouched, valid same-id merge still succeeds) and describe `... quarantine collision uses the authoritative classifier (audit GAP-3)` (enum + structure failure classes); `ImportExportView.test.tsx` (preview advisory names the id; a stale cached quarantine list cannot bypass the transaction) |
| **GAP-4** | Multi-tab concurrent writes to the same record | `updateDrug` re-reads inside the transaction and merges only provided changes (`:181-202`), so *different-field* concurrent saves compose; same-field and `targets`-replacing saves are last-writer-wins with no conflict detection | No multi-tab tests; no documented concurrency guarantee; loss scenario plausible but unproven | Not attempted (would require two browsing contexts; jsdom cannot model it credibly) |

**Not verified (blocker stated):**

| ID | Path | Blocker |
| --- | --- | --- |
| NV-1 | Browser-level durability if the process crashes mid-transaction | Cannot be exercised faithfully outside a killed-browser harness; relied on Dexie/IndexedDB abort semantics plus committed rollback tests (`store.test.ts:309,451`) |
| NV-2 | v1→v2 migration against real legacy user data | No real user database is accessible (by design); only synthetic fixtures (`database.test.ts`) |
| NV-3 | Exhaustive per-column CSV round trip (all 57 columns) | Not enumerated line-by-line; core value/unit/provenance columns and the documented loss contract were verified |

---

## 7. Safeguards verified during the audit

- **Phase 9A (provenance preservation):** policy `docs/provenance.md:48-54`;
  implementation `DrugForm.tsx:118,254,257-277` (stable target id + kind,
  `Object.is` value + identical unit → complete stored provenance object,
  unknown keys included); tests `views.test.tsx:394-` and the persistence-level
  test asserting raw-row provenance after an unrelated edit. Not modified by
  this audit. **Intact** — the DI-02 identity caveat is now closed at the
  import boundary (Phase 13); pre-existing stored id collisions remain
  ambiguous (out of scope).
- **Phase 9B (preferences separation):** `preferences/schema.ts:110-114`
  contains only `version`, `theme`, `calculator.settings`; reset scope proven by
  `SettingsPage.test.tsx:211,241` and `preferences/store.test.ts:226,244`;
  saved curve settings cannot touch scientific inputs and flag staleness
  (`calculator/store.ts:288`, tests `store.test.ts:642-682`). **Intact.**
- **Phase 10 (target metadata preservation):** `storedTargetMetadata`
  (`DrugForm.tsx:148-158`) reattaches `gene`/`action`/`species`/`notes` by
  stable id with per-key conditional spreads; 8 form tests
  (`views.test.tsx:636-`), 2 real-repository tests
  (`DrugForm.persistence.test.tsx`), 1 E2E (`e2e/library.spec.ts:197`).
  **Intact** (verified in code; not modified).
- **NPSB recovery (Phases 8A/8B):** full §8 pre-write validation, atomic
  clear+rewrite, four distinct outcomes with refresh-only retry, sidecar
  fidelity, duplicate-key and bounds checks, quarantine inclusion, mutual
  format rejection — each row of matrix F verified against code + committed
  tests + E2E. **Intact.**
- **Additional safeguards observed:** final `assertWritable` schema gate before
  every drug write (`dexieDrugRepository.ts:422-430`); quarantine reported with
  the raw row, never repaired (`:129-143`); export panel's "not a complete
  backup" warning with quarantine count (`ExportPanel.tsx:82-90`); CSV warning
  enumerating its own losses (`:98-105`); import/restore never reporting a
  committed transaction as a rollback (`store.ts:214-228,248-262`).

---

## 8. Prioritized remediation backlog

Ordered by the phase-brief priority rules (silent data loss → provenance/identity
corruption → atomicity → undocumented loss → recoverability → coverage). Each
item is scoped to be implementable and testable in one focused phase.

| Order | Item | Targets | Scope sketch | Risks/dependencies |
| --- | --- | --- | --- | --- |
| 1 | **S1 — Phase 12 (done)** | DI-01 | Reattach `description`/`casNumber` from the stored record in `DrugForm.buildInput` (Phase-10 conditional-spread pattern); add form + persistence regression tests | Must keep absent-stays-absent; no new UI; verify no other partial-contract field was missed in `DrugChanges` (audit found none) |
| 2 | **S2 — Phase 13 (done)** | DI-02 | Add per-drug target-id uniqueness to `validateNpslFile` (blocking `DUPLICATE_ID`, zero writes) + rejection and no-misattribution tests | Previously-accepted violating files become un-importable; stored ambiguous libraries are out of scope |
| 3 | **S3 — Phase 14 (done)** | DI-03 | Round-trip-safe list/text handling in `DrugForm` (preserve untouched arrays verbatim; explicit trim policy for edited fields) | Product decision on delimiter/UX; touches only form code — decision taken: keep the comma-delimited widget unchanged for edited lists and document the embedded-comma limitation; untouched fields bypass the widget round trip entirely |
| 4 | **S4 — Phase 15 (done)** | DI-04 | Document (and optionally normalize-or-reject) `-0` in the NPSL contract, aligning with the NPSB sidecar story | Decision taken during the phase: **exact preservation** instead of the sketched normalize-or-reject — the serializer emits the numeric `-0` token (collision-proof placeholder) and the form's draft-text identity rule keeps untouched `-0` parameters; no sidecar, no version bump, no user-visible value policy change |
| 5 | **S5 — Phase 16 (done)** | GAP-1, GAP-2 | Two committed regression tests only (targets-replacing + extensions; PK values under unrelated edit). No production change | Done exactly as scoped: two repository GAP-1 tests (stable-identity reattachment; removal/new-id non-transfer boundary), one form-path GAP-1 test, one GAP-2 PK round-trip test, plus the DI-04 collision-branch test; **no production code changed** |
| 6 | **S6 — Phase 17 (done)** | GAP-3 | Decide and document the quarantine-vs-import-collision policy; if protection wins, surface quarantined-id collisions in the preview | Done: decision taken — **protection wins**. A merge id colliding with a row the hydration classifier quarantines is a blocking `QUARANTINE_CONFLICT` raised inside the import transaction before any write (whole document rejected, quarantined row byte-identical, still reported); the preview surfaces an advisory naming the ids while the repository transaction remains the authoritative boundary (a stale preview cannot bypass it); policy documented in `validation.md`, `npsl-format.md` §6, ADR-15 and `repository.ts`; repository + UI regression tests committed; no schema or format change |
| 7 | **S7** | GAP-4 | Document multi-tab expectations (field-merge behavior; last-writer-wins for same-field/targets saves) and pin current behavior with a test | Documentation-first; no locking proposed |

**All four confirmed findings are remediated: S1 (DI-01, Phase 12), S2
(DI-02, Phase 13), S3 (DI-03, Phase 14) and S4 (DI-04, Phase 15).** S1 was
silent field loss through the *most common* supported workflow (any edit of an
imported/restored user-origin record); S2 was provenance corruption through
import-then-edit, closed by blocking the colliding file before any write; S3
was silent normalization of untouched list/text metadata on every save, closed
by submitting stored source values verbatim for unchanged drafts; S4 was
undocumented `-0` round-trip loss (value sign, then provenance restamp),
closed by exact preservation — the serializer's numeric `-0` token plus the
form's draft-text identity rule. **S5 (GAP-1/GAP-2 regression tests) is
done — Phase 16 — closing both coverage gaps with committed tests and no
production change. S6 (GAP-3) is done — Phase 17 — with the decision that
quarantine protection wins over Merge: a colliding id is a blocking
`QUARANTINE_CONFLICT` inside the transaction, surfaced as a preview
advisory, with the policy documented across `validation.md`,
`npsl-format.md`, ADR-15 and `repository.ts`.** The highest-priority open
item is now S7 (GAP-4 documentation), then the unverified paths NV-1..3.

**No finding in this audit warrants emergency remediation ahead of the normal
sequence:** every loss requires a specific trigger (records carrying
description/CAS, a spec-violating file, comma-bearing lists, `-0` values), and
`.npsb` recovery backups remain fully functional as a safety net.

---

## 9. Limitations

1. **Line numbers** refer to commit `e36a89990af6d04df989daf2f67b0c8291932f6e`
   and will drift with future changes.
2. **Reproductions ran in jsdom + `fake-indexeddb`**, not real Chromium
   IndexedDB; transaction semantics in NV-1 were therefore not exercised.
3. **No real user data was accessed.** Migration verdicts rest on synthetic
   fixtures (NV-2).
4. **Seven temporary experiments (`R1`–`R7`)** are local results recorded in
   §5/§6 — they are *not* committed tests; only the committed suites named in
   §4 constitute permanent coverage. All scratch code was removed before this
   commit.
5. The audit **inspected** the paths named in §4 and does not claim exhaustive
   proof of correctness; untested combinations beyond those named (for example
   NPSL files combining duplicate target ids with extension fields, or CSV
   round trips of every column, NV-3) were not executed.
6. Findings concern **recognized-field handling at boundaries**; a broad
   refactoring-style review of UI state (filter text, panel state) was out of
   scope as non-persistent.
7. Existing warnings observed during gates (3 × `only-export-components` lint
   warnings, Plotly chunk-size build warning, dev-only audit advisory, jsdom
   "navigation not implemented" notices) are pre-existing and unrelated to this
   report.
