# Changelog

All notable changes to Neuropharmacology Sandbox are documented here.
Versions follow Semantic Versioning; this project is a source-available,
noncommercial static web application (see [LICENSE](LICENSE)).

## [Unreleased]

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
