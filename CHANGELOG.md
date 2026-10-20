# Changelog

All notable changes to Neuropharmacology Sandbox are documented here.
Versions follow Semantic Versioning; this project is a source-available,
noncommercial static web application (see [LICENSE](LICENSE)).

## [Unreleased]

### Added — general simulation scenario editor (phase 43)

- **The simulation page is now an editable scenario editor.** Model
  parameters (V_c, V_p, CL, Q, with catalog unit choices, and initial
  amounts in canonical mg), the time horizon and a uniform output interval,
  every dosing event, and — under *Advanced solver settings* — all six
  solver options are editable. The synthetic example remains the starting
  template and can be restored with **Reset to synthetic example**.
- **Two kinds of validation stay visibly separate.** Unparseable or blank
  fields are reported as form errors (a blank is never treated as zero) and
  the engine is not called; once the draft compiles, `simulate()` remains
  the only scientific validator, and its typed errors (code, stage, field,
  event id) are shown and attributed to the offending control.
- **Dosing events**: add, edit and remove IV boluses and IV infusion
  sessions. A session compiles into the engine's `infusion-start` and
  `infusion-stop` events with one shared `infusionId` and stable ids;
  removing a session removes both events. New rows start blank.
- **Output grid**: a pure generator builds `outputTimes` from start, end
  and interval using integer indices, exact endpoints and a documented
  20 000-sample limit; an over-large grid is rejected, never thinned.
- **Stale results are impossible**: any edit clears the previous result, so
  a chart is never attributed to a different draft.
- **Charts**: concentration, amount and — when the scenario has an
  infusion — an infusion-rate step chart drawn only from the engine’s
  `infusionRates`. Chart visibility toggles are presentation-only and never
  re-run the simulation; the infusion toggle is disabled with an
  explanation when no infusion exists.
- Widened table scroll containers are now keyboard-focusable (axe
  `scrollable-region-focusable`), which also benefits existing tables.
- No persistence, database schema, network or import/export change.

## [Unreleased]

### Added — simulation demonstration page and charts (phase 42)

- **A `/simulation` page** (navigation entry “Simulation”) that runs one explicitly
  labelled **synthetic** two-compartment IV scenario through the Phase 41
  `simulate()` engine: V_c 10 L, V_p 20 L, CL 2 L/h, Q 3 L/h, 0 mg initial
  amounts, a 100 mg bolus at t = 0, a 10 mg/h infusion from t = 2 to 6 h and a
  30 mg bolus at t = 8 h over a 24 h horizon, with explicit solver settings.
  Every number is a demonstration parameter, not a compound, clinical or
  published value.
- **A pure chart adapter** (`simulationAdapter`) turns the engine's samples
  into two charts with separate dimensions: concentration (mg/L) and amount
  (mg, plus the cumulative input/eliminated accounting states). Values are
  copied in emission order; nothing is computed, smoothed or reordered.
- **Instantaneous events stay instantaneous**: the pre-event and post-event
  samples at one time are both plotted, so an IV bolus draws as a vertical
  jump at its exact time, and hover text names the side and the event group.
- **Dosing-event table** listing every applied event in engine order
  (several events at one time are kept), with a stop explicitly labelled as
  administering no amount.
- **Diagnostics**: solver method, tolerances, accepted/rejected steps,
  derivative evaluations, mass-balance residual against its derived
  tolerance, canonical parameters, warnings, model equations, structural
  assumptions, and an explicit note that a completed run is not an
  external qualification.
- **Structured errors**: a failed run clears any previous result and shows
  the engine's typed errors; no chart is drawn for an invalid or
  incomplete result.
- No persistence, store, schema migration, network access or scenario
  editing in this phase.

## [Unreleased]

### Added — dynamic pharmacokinetic simulation engine (phase 41)

- **A reusable adaptive ODE solver** (`src/engine/simulation/solver.ts`):
  Dormand–Prince 5(4) with the embedded error estimate
  `E = sqrt(mean((e_i / (atol + rtol·max(|y_i|, |y_i^(5)|)))²))`, FSAL reuse,
  step clipping to every target time, and conservative step-size control
  (safety 0.9, bounds 0.2–5). Invalid settings, wrong derivative length,
  non-finite derivatives or states, an exhausted step budget and time that
  cannot advance in double precision all return typed errors — never a partial
  result. Analytical tests: constant derivative, exponential decay, a coupled
  linear system, the circle at π, and tolerance-convergence.
- **An open two-compartment IV PK model**
  (`src/engine/simulation/models/two-compartment-pk.ts`):
  `dA_c/dt = R_in − CL·C_c − Q(C_c − C_p)`, `dA_p/dt = Q(C_c − C_p)`,
  with integrated elimination (`A_e`) and cumulative-input (`A_in`)
  accounting states, `C_c = A_c/V_c`. `Q = 0` and `CL = 0` are valid
  limits and are tested against closed forms.
- **A deterministic dosing scheduler** (`src/engine/simulation/events.ts`):
  IV bolus (instantaneous jump), constant-rate infusions with per-infusion
  session identity and summed overlapping rates. Same-time ordering is
  specified as stops → boluses → starts, then by event id code point; a total
  order independent of array position. Missing starts, unstopped sessions,
  repeated stops, zero-duration intervals and duplicate ids are rejected.
- **An orchestrator and report** (`src/engine/simulation/simulate.ts`):
  validates and converts the scenario once, integrates boundary by boundary
  (output ∪ event ∪ end), emits `pre-event`/`interval`/`post-event` samples
  with their event group, applies each event exactly once, invalidates the
  solver cache at every event, and returns either a complete
  `SimulationReport` (samples, event trace, infusion steps, solver
  diagnostics, normalized parameters, mass balance, warnings) or typed
  failures with no samples at all.
- **Unit system extension**: new physical dimensions `mass` (g, mg, µg),
  `volume` (L, mL), `clearance` (L/h, mL/h, mL/min) and
  `mass-flow-rate` (mg/h, µg/h, µg/min, g/h). These are distinct from the
  existing inverse-time `rate` dimension; every cross-dimension conversion is
  refused.
- **Mass-balance accounting**: `A_c + A_p + A_e ≈ A_c(0) + A_p(0) + A_in(t)`
  with a single reference point (ADR-25). A bolus at the start time is part
  of the input, not of the reference amount, so it is counted exactly once —
  the pre-event sample reads 100 mg / 0 mg and the post-event sample
  130 mg / 30 mg for a 100 mg start state and a 30 mg bolus. The tolerance is
  derived from the solver settings and the mass scale.
- No UI, no persistence format and no schema migration: existing calculators,
  drug library records, import/export and backup formats are unchanged.


### Fixed — ChEMBL target search requests the documented JSON format (phase 40)

- **Target search now uses `target/search.json?q=…&limit=…`.** The
  previous request used the format-less `target/search` path, whose
  representation depends on HTTP content negotiation: the API documents
  XML as the default when no format is given (live check: the same URL
  without `Accept: application/json` answers `application/xml`), and its
  `Vary: Accept, Origin` header shows one URL can answer in more than one
  format. Every other ChEMBL request in the app already pinned `.json`;
  the target search was the one exception. The `Accept:
  application/json` header is still sent.
- Regression tests pin the exact JSON URL (a reverted format-less path
  fails the suite instead of being absorbed by the mocks), keep the
  field mapping, the invalid-envelope `invalid-response` case, real HTTP
  statuses, cancellation and the `Accept` header intact.

### Changed — measurement endpoints are individually selectable (phase 40)

- The single-choice "Measurement endpoints to retrieve" selector becomes
  an accessible multi-select group: **Ki, Kd, IC50 and EC50 are
  independent checkboxes** (the default selects all four — identical to
  the previous behaviour), plus a separate, mutually exclusive **"All
  reported endpoints"** mode that disables the individual choices and
  intentionally omits the endpoint filter.
- In selected mode the checked endpoints are sent to ChEMBL as
  URL-encoded `standard_type__in=…`; the four choices are the
  model-parameter endpoints — not a catalogue of every activity endpoint
  a source may report — and only endpoints the source actually reports
  can be returned.
- **An empty selection is never sent as "all".** Retrieval stays disabled
  with a clear validation message, the store refuses the request, and the
  adapter retrieves nothing (without a request) for an empty list.
- Changing the selection invalidates already-fetched measurements and
  their selection — an in-flight request is aborted and a late answer is
  discarded — so the fetched list always shows the filter it was fetched
  under, and paging continues only under that same filter.
- Measurement handling is unchanged: endpoint names, values, units,
  relation qualifiers (`<`, `>`), assay/target/provenance/licensing data
  and the explicit "Use as parameter…" promotion keep every existing
  rule.

### Added — delete stored compound identity records (phase 39)

- **A stored compound identity record can now be deleted** from the
  Stored data panel, behind a two-step, keyboard-operable confirmation
  that names the record and states how many measurement records go with
  it (Escape cancels; nothing happens without the acknowledgement). It
  removes only the local acquisition copy.
- Deletion is identity-scoped and atomic: one read-write transaction
  removes the compound row and exactly the observations whose validated
  `compoundId` equals that compound's id — never a same-named record,
  never another compound's measurement, and a failure rolls back with
  nothing removed.
- The same "protection wins" policy as import applies: a quarantined
  compound row, or a measurement it owns that fails source-record
  validation, makes the deletion refuse and preserves everything
  byte-identical instead of being deleted by a path that cannot prove
  what it is removing. A missing id reports `NOT_FOUND`; nothing fails
  silently.
- **The drug library is never touched.** A `Drug.sourceRecords`
  snapshot imported earlier is an independent, durable copy: after the
  source record is deleted, the library entry keeps its identifiers,
  attribution, parameters, targets and notes (no cascading delete — the
  confirmation and the success notice both say so).
- The panel re-reads IndexedDB after every attempt: a success refreshes
  the list and counts from storage; a failure shows the reason with the
  row kept.

### Changed — complete Data Sources → Library import (phase 36)

- **"Add to drug library" now imports the complete source record.** A
  stored compound no longer reduces to a name, synonyms and an optional
  CAS number: the drug record receives a typed snapshot
  (`Drug.sourceRecords`) with its external identity (`source` +
  `sourceId`), the preferred name and **all** synonyms, every identifier
  the source supplied (PubChem CID, ChEMBL id, InChIKey, SMILES, molecular
  formula, molecular weight in g/mol, CAS), the full source attribution
  (record URL, retrieval timestamp, source version, license notice and
  license URL) and **every stored experimental observation** of exactly
  that record — endpoint, value, unit, qualifier, raw relation, target
  (name, source id, URL, organism), species, assay, reference, activity
  comment, data-validity note and per-measurement provenance.
- Imported data is structured and separate from user notes; missing fields
  stay absent, and nothing is derived, defaulted or invented.
- Observations are linked by **validated source identity**
  (`compoundId === ${source}:${sourceId}`), never by display name. They
  remain measurements: an import never fills `kd`/`ki`/`ec50`/`ic50`, and
  the existing "Use as parameter…" flow keeps all of its validation.
- Repeat imports are identity-aware: re-importing the same record appends
  only new measurements and reports `already-linked`; a same-source record
  with a different id is reported as a `conflict` and never merged; a
  same-name compound with a different source id is a separate record.
- An existing drug record can be **explicitly linked** (a chosen id, never
  a name match): only `sourceRecords` is submitted, so its targets, model
  parameters, target metadata, identifiers and notes are preserved, and
  the write is revision-guarded like every other edit.
- The library detail page gains sections for identifiers, chemical
  properties, source attribution/license and the imported observations
  (honest "not reported" markers and empty states; disagreeing
  measurements are shown side by side). The library list shows a
  source-origin indicator.
- The snapshot is a first-class stored field validated by the shared
  `drugSchema`, and it survives reloads, ordinary edits, `.npsl`
  export/import and `.npsb` recovery round trips. The field is optional and
  additive: legacy records, old `.npsl` files and pre-36 `.npsb` archives
  keep loading unchanged — **no schema, persistence or database version
  bump**, and no migration (see ADR-22 in
  [docs/decisions.md](docs/decisions.md)).

### Known limitation

- The CSV export is a flattened projection of drug *parameters* and does
  **not** carry imported source data or observations; `.npsl` and `.npsb`
  are the lossless carriers.

---

## [0.1.0-alpha.1] — published 2026-10-13 (pre-release)

> **Status: published preview release** (2026-10-13). `v0.1.0-alpha.1`
> is an **alpha** GitHub prerelease — not a stable release. The
> download archive and its SHA-256 checksum on the
> [GitHub Releases page](https://github.com/ookoukibob/Neuropharmacology-Sandbox/releases/tag/v0.1.0-alpha.1)
> are the authoritative location for the downloadable artifact,
> following [docs/releasing.md](docs/releasing.md).

### What this preview contains

- **Three mathematical models** — first-order one-compartment
  elimination, single-site receptor occupancy, and Hill/Emax
  dose–response — calculated only from explicit user inputs or values
  explicitly loaded from the local library. Every result exposes its
  formula, substituted inputs, intermediate steps, assumptions and
  warnings.
- **Provenance-aware drug library** — browser-local persistence
  (IndexedDB/Dexie, schema-versioned with in-place migration,
  quarantine reporting on hydration). Every stored scientific value
  carries one of five explicit provenance states; the application never
  invents a parameter or a source.
- **Import/export** — `.npsl`/`.json` interchange with preview →
  confirm (replace requires explicit destructive acknowledgement), CSV
  import through an explicit column-mapping step with declared units,
  and whole-library export (lossless `.npsl`/`.json` with a visible
  warning for excluded envelope/quarantine data; lossy CSV that always
  warns it is not a backup format).
- **Recovery backup and restore** — `.npsb` full-storage snapshots
  (quarantined and unknown-field rows included, numeric sidecar for
  `-0`/`NaN`/`±Infinity`) with an acknowledged, atomic,
  all-or-nothing restore. `.npsb` and `.npsl` deliberately reject each
  other's files.
- **On-demand data sources** — explicit-request-only PubChem and
  ChEMBL retrieval with per-record source links, retrieval dates and
  license attribution; imports are atomic, never overwrite existing
  records, and a measurement becomes a model parameter only through an
  explicit, provenance-linked action. No bundled database; nothing is
  downloaded at startup or in the background.
- **Settings** — device-local theme and per-model curve-display
  preferences with a scoped reset that never touches scientific data.
- **Accessibility** — keyboard-operable core workflows, semantic
  landmarks, accessible error announcements, and axe-core WCAG A/AA
  scans over the main screens in the E2E suite.

### Integrity and durability guarantees (tested)

- Optimistic concurrency on every drug write: stale saves and deletes
  are rejected atomically, keeping the stored record untouched.
- **NV-1 crash durability**: a real-browser test kills the browser
  process mid-restore and verifies byte-level rollback on restart, plus
  a committed-restore positive control.
- Exhaustive 57-column CSV contract, `-0` round-trip preservation,
  quarantine-vs-merge collision protection, duplicate-target-id
  rejection, and edit paths that preserve untouched fields verbatim.
- CI enforces four blocking checks on every pull request: `Quality
  gates`, `Coverage`, `E2E smoke test`, `NV-1 crash durability`.

### Security posture

- `npm audit --omit=dev` (production dependency tree): **0 known
  vulnerabilities** at the time of this preparation.
- The full development tree reports **7 high-severity advisories**, all
  confined to the `shadcn` CLI toolchain (chain: `braces` →
  `micromatch` → `fast-glob` → `@shadcn/registry`/`ts-morph` →
  `shadcn`; the `braces` entry is the stack-exhaustion issue
  GHSA-vfj7-8cjw-p6xm). npm offers no non-breaking fix — the only
  remediation is a **major** upgrade to `shadcn@1.0.0`, which is not
  taken in this preparation. The affected toolchain is **build-time
  scaffolding only**; none of these packages are production
  dependencies or part of the shipped static bundle, and the blocking
  production audit stays clean. See the "Known tooling notes" in
  [docs/architecture.md](docs/architecture.md).

### Declared scientific and clinical boundaries

- Model results are mathematical outputs under declared inputs and
  assumptions. They are **not clinical predictions, not dosage
  advice and not a medical decision-support system**.
- Kd, Ki, EC50 and IC50 are distinct parameters and are never silently
  substituted for one another. Missing inputs make a calculation
  impossible — nothing is guessed or defaulted.
- There is **no bundled authoritative pharmacology database**; external
  data are retrieved only on explicit user request.

### Known limitations

- **NV-2 remains OPEN.** No authentic historical user database has been
  obtained or inspected. Schema-migration evidence uses synthetic
  legacy databases only; historical-data compatibility is therefore
  **not** validated against real user data. The authorized-validation
  runbook exists ([docs/nv2-authorized-validation.md](docs/nv2-authorized-validation.md))
  but verifies nothing by itself.
- Editing the same record from several tabs can produce a conflict.
  Stale writes and stale deletes are rejected atomically **before**
  anything modifies the stored record, and the application surfaces an
  explicit conflict instead of silently overwriting newer data. The
  user resolves it through the supported recovery actions — open the
  latest record in a new tab, or reload (dismissing the conflict
  preserves the draft). Conflicting drafts are never merged
  automatically, and re-applying some edits by hand may be required.
  See [docs/data-integrity-audit.md](docs/data-integrity-audit.md)
  GAP-4 and ADR-21 in [docs/decisions.md](docs/decisions.md).
- `.npsb` recovery backups are not checksummed or authenticated — their
  fidelity boundary is stated in the UI.
- Crash-durability evidence covers browser-process termination, not
  hardware power loss or physical storage failure.
- IndexedDB data are origin- and browser-profile-specific; clearing
  site storage can remove the library, and changing origin does not
  migrate data.
- CSV edit path: the comma-delimited list limitation documented in
  [docs/validation.md](docs/validation.md) remains.
