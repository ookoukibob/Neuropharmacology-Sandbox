# Experimental concentration–time datasets

**Status: Phases 47A–47C and Phase 48 (noncompartmental analysis) — implemented.**
This document is the contract for measured-dataset import, validation, local
storage, inspection and `.npex` interchange, the optional one-compartment
mono-exponential decay fit (§10), raw-residual/RMSE diagnostics (§11), the
practical identifiability screen (§12), the two-candidate comparison with a
conditional common-variance AICc (§13), residual-structure diagnostics with a
residual-spread screen (§14), the opt-in proportional-variance likelihood
path (§15), and noncompartmental analysis (§16).

All examples below are synthetic test data, not pharmacological information.

---

## 1. Purpose and non-goals

Phase 47A adds a first-class record for **measured concentration–time data**:

- import explicitly mapped CSV files or a single-dataset `.npex` file;
- validate every row before writing anything;
- store datasets and their ordered measurements locally in IndexedDB;
- inspect declared units, provenance and the complete ordered table;
- display observed points on a presentation-only chart;
- rename or permanently delete a saved dataset;
- export one dataset to the versioned `.npex` format and re-import it with
  exact scientific fidelity;
- include every experimental dataset in full `.npsb` recovery backups.

**Non-goals.**

- No AUC/Cmax derivation, interpolation, smoothing, automated terminal-phase
  selection or alternative-model regression. Phase 47C adds descriptive raw
  residuals, RMSE and a clearly limited data-support screen; formal uncertainty
  and model selection remain deferred.
- No automatic conversion between time or concentration units.
- No merging of this store into the drug library, NPSL documents or the
  source-data Layer B `ExperimentalObservation` records.
- No averaging, deduplication, sorting, interpolation or normalization of
  measured values.
- No claim that a dataset is suitable for a particular analysis. The declared
  units and source provenance are shown; the scientific interpretation is the
  user's.

---

## 2. Distinct domain model

The dataset model lives in
[`src/domain/experiments/experimental-dataset.ts`](../src/domain/experiments/experimental-dataset.ts).

| Type | Meaning |
| --- | --- |
| `ExperimentalDataset` | One named, stored dataset with declared units, metadata, provenance and an ordered measurement array |
| `ExperimentalMeasurement` | One measured time/concentration pair plus its local id, source row, optional sample id and note |
| `ExperimentalDatasetInput` | Validated content before local identity and timestamps are assigned |
| `ExperimentalMeasurementInput` | A measurement before its local id is assigned |
| `ExperimentalDatasetSummary` | List metadata only; no measurements |

`ExperimentalDataset` is deliberately **not** `ExperimentalObservation`.
`ExperimentalObservation` is a Layer B source-data record describing a
reported potency/affinity measurement at a target (for example a ChEMBL
activity). A dataset here is an ordered series of measured time/concentration
pairs. Neither type is ever converted into the other implicitly, and this
phase does not promote a dataset into a drug parameter.

### 2.1 Fields and invariants

A dataset declares:

- `name`: trimmed, non-empty, at most 120 characters, not required to be unique;
- `timeUnit`: required, resolved against the existing unit catalog and must
  have dimension `time`;
- `concentrationUnit`: required, resolved against the existing catalog and
  must have dimension `molar-concentration` or `mass-concentration`;
- `measurements`: at least one and at most 25,000, in source row order;
- `provenance`: `source` (`csv` or `npex`), optional original file name, and
  the original import time;
- optional dataset `notes`, at most 10,000 characters.

A measurement declares:

- `id`: local stable identity, assigned on import, never supplied by `.npex`;
- `sourceRow`: the 1-based **data row** in the source (header excluded); this
  is provenance, not a local identity;
- `time` and `concentration`: finite, non-negative JavaScript numbers; zero is
  valid;
- optional `sampleId`, at most 200 characters;
- optional measurement `note`, at most 1,000 characters.

Every accepted sample id and note is stored **exactly**, including leading
and trailing whitespace. Emptiness is decided with a separate whitespace-only
check: an empty or whitespace-only optional value becomes absent, while a
non-empty value is never rewritten to its trimmed form. Dataset names are the
one exception — they are trimmed for display. Length limits apply to the exact
stored text.

Nothing in the model derives a unit, converts a value to another unit, sorts
the measurements, detects duplicate timestamps, or removes exact replicates.
Two rows with the same time and concentration are two legitimate
observations.

### 2.2 Units are always explicit

The existing unit catalog is the only unit authority. For time, the symbols
are `s`, `min`, `h` and `d` (catalog aliases are also resolvable). For
concentration, the catalog currently offers molar units (`M`, `mM`, `µM`,
`nM`, `pM`, `fM`) and mass-concentration units (`g/L`, `mg/L`, `µg/mL`).
Molar and mass concentration are different dimensions and are never
interchanged.

The unit is stored as declared, after trimming. Import never guesses a unit
from a column header, filename, numeric magnitude, another column, a previous
dataset or a neighbouring row. CSV import requires the user to select both
units; `.npex` must carry both explicitly.

The plot axis titles use these declared unit strings. Plotting does **not**
convert values or reinterpret the unit.

---

## 3. CSV import contract

The CSV path uses the application's existing RFC 4180 parser
([`parseCsv`](../src/features/import-export/csv/parseCsv.ts)); there is no
second CSV parser. The dataset-specific validation is in
[`src/features/experiments/csvDataset.ts`](../src/features/experiments/csvDataset.ts).

### 3.1 Mapping

The file picker reads a file of at most **10 MiB** (UTF-8 bytes). After
parsing:

- a header row is required and the file must contain at least one data row;
- at most **25,000 data rows** are accepted;
- the user must explicitly select a time source column and a concentration
  source column;
- the user must explicitly select a catalog time unit and concentration unit;
- optional sample-id and note source columns may be selected;
- one source column may be mapped to only one destination;
- dataset name and notes fields are explicit; the name is required.

Every mapping select starts unmapped. A header such as `time`, `conc`, `h` or
`mg/L` is shown as text but never auto-selected and never interpreted as a
unit.

### 3.2 Per-row validation

For each data row, the importer:

1. reads the mapped time and concentration cells;
2. trims surrounding whitespace;
3. requires a **plain decimal or scientific-notation literal** matching
   `[+-]?(digits[.digits]|.digits)[eE...]`;
4. converts it with `Number`;
5. rejects a non-finite result or a negative number;
6. normalizes negative zero to positive zero;
7. validates optional sample id and note lengths, treating only an empty or
   whitespace-only cell as absent and preserving every other cell exactly
   (including surrounding whitespace);
8. keeps the row in source order and assigns `sourceRow = dataRowIndex + 1`.

Rejected examples include blank cells, `<0.1`, `>5`, `BLQ`, `N/A`, `NA`, `-`,
ranges, units inside a numeric cell, `NaN`, `Infinity` and any other text.
Each issue names the data row and, where applicable, the source column. Zero
is valid.

All-row success is required: if any mapped or row-level issue exists, the
preview reports valid/invalid counts and issues but produces **no
`ExperimentalDatasetInput`**, so no confirm control can commit it. The
successful preview is read-only; only explicit confirmation calls the
repository. The repository revalidates the complete dataset before its
transaction, so the final boundary does not trust a stale preview.

The importer does not require unique timestamps or sample ids and does not
sort or group. Duplicate timestamps, duplicate sample ids and exact
replicates are preserved as separate rows.

Provenance for a CSV import is:

```json
{
  "source": "csv",
  "fileName": "original-file.csv",
  "importedAt": "2026-03-01T00:00:00.000Z"
}
```

---

## 4. `.npex` interchange format

`.npex` is a separate, versioned, JSON-based file format for **one**
experimental dataset. It is not NPSL (`.npsl`/`.json`), not the CSV
interchange projection and not the `.npsb` recovery archive. The
implementation is in [`src/data/npex/npex.ts`](../src/data/npex/npex.ts).

### 4.1 Envelope

The top level is a strict object with exactly these fields:

```json
{
  "formatId": "npex",
  "formatVersion": "1.0.0",
  "exportedAt": "2026-03-01T00:00:00.000Z",
  "dataset": {
    "name": "Synthetic study 47A",
    "timeUnit": "h",
    "concentrationUnit": "mg/L",
    "notes": "Synthetic example.",
    "provenance": {
      "source": "csv",
      "fileName": "synthetic-47a.csv",
      "importedAt": "2026-02-28T12:00:00.000Z"
    },
    "measurements": [
      {
        "sourceRow": 1,
        "time": 0,
        "concentration": 0,
        "sampleId": "A",
        "note": "baseline"
      },
      {
        "sourceRow": 2,
        "time": 0,
        "concentration": 0,
        "sampleId": "A",
        "note": "exact replicate"
      },
      {
        "sourceRow": 3,
        "time": 2,
        "concentration": 1.5,
        "sampleId": "B",
        "note": "observed"
      },
      {
        "sourceRow": 4,
        "time": 4,
        "concentration": 2.25,
        "sampleId": "B"
      }
    ]
  }
}
```

`formatId` is the exact literal `"npex"`. `exportedAt` is the export time and
is informational only. The dataset and all nested objects are strict: unknown
keys are rejected rather than silently ignored. Optional keys (`notes`,
`fileName`, `sampleId`, measurement `note`) are omitted when absent.

The file contains no local database ids, no dataset `createdAt`/`updatedAt`,
no measurement ids and no Dexie record shape. Those are assigned locally when
a validated preview is confirmed.

### 4.2 Version rule

`npex` has its own semantic-version space, independent of NPSL, `.npsb` and
the application version. The reader accepts a file when:

- the major version equals the reader's major (`1`), and
- the file minor is less than or equal to the reader minor.

The patch segment is free. With reader `1.0.0`, version `1.0.7` is accepted;
`1.1.0` is rejected as newer than this build; `2.0.0` is rejected for its
major. Malformed versions are rejected. Compatibility failure is explicit;
nothing is partially imported.

A future incompatible extension or meaning change must bump the major
version. Additive, backward-readable fields may use a minor bump.

### 4.3 Import validation

Parsing is fail-closed and read-only:

- size at most **10 MiB** UTF-8 bytes;
- duplicate JSON object keys anywhere are rejected (a textual scan, because
  `JSON.parse` would silently keep only the last value);
- nesting deeper than 100 is rejected;
- the root, envelope and dataset must have the exact expected shapes;
- the version rule above must pass;
- both units must resolve from the existing catalog with the required
  dimensions;
- the dataset name and notes, sample ids and notes must satisfy their limits;
- at least one and at most 25,000 measurements are required;
- every `sourceRow` must be a positive whole number;
- every time and concentration must be finite and non-negative; zero is
  valid; negative zero is normalized to zero;
- no scientific transformation is performed.

Every failure reports a path such as
`dataset.measurements[2].time` and produces no importable dataset. The
preview is read-only, and the repository revalidates before writing.

### 4.4 Round-trip fidelity

For a dataset created through the application, `.npex` export followed by
`.npex` import preserves the following:

- dataset name, declared `timeUnit` and `concentrationUnit`;
- optional dataset notes;
- provenance exactly as originally stored, including the original
  `source`, file name (when present) and import timestamp;
- measurement order and count;
- each `sourceRow`, numeric time and concentration value, optional sample id
  and optional measurement note.

Text equality is exact: accepted sample ids and notes keep every code unit,
including leading and trailing whitespace, through parse, import, storage and
export. Numeric equality is equality of the JavaScript binary64 value, not of
the original textual spelling: `2.0` may serialize as `2`. No arithmetic,
rounding, averaging, conversion or reordering occurs. Negative zero is
normalized to positive zero at the interchange boundary.

Importing a `.npex` file creates a **new local identity** (dataset id,
timestamps and measurement ids). It does not preserve the exporting device's
database identity, and it does not rewrite the original provenance to claim a
new source or import time. Two imports of the same file are two independent
local datasets.

Export validates the stored dataset first and refuses to produce a file that
would exceed the byte or measurement limits. Downloads use the
`.npex` extension and `application/json;charset=utf-8`; a safe filename is
derived from the dataset name.

### 4.5 Why `.npex` is separate

NPSL describes a drug library and its parameters, not measured time series.
CSV is a mapping-based import convenience and has no versioned dataset
envelope. The `.npsb` recovery archive is a raw all-store storage snapshot
with local ids and timestamps, not a portable scientific interchange file.
Keeping `.npex` separate avoids overloading any of those contracts and makes
the one-dataset round-trip boundary independently testable. See ADR-28.

---

## 5. Local persistence

The database is the existing `neuropharmacology-sandbox` IndexedDB database.
Dexie **version 6** adds one additive store:

```ts
this.version(6).stores({
  // unchanged stores …
  experimentDatasets: 'id, updatedAt',
})
```

There is no upgrade hook and no rewrite of existing scientific rows. A
version 5 database opens at version 6 with `experimentDatasets` empty; all
existing stores are preserved.

A stored record contains the complete `ExperimentalDataset`: local record id,
created/updated timestamps, declared units, name and notes, provenance, and
the ordered measurements with local measurement ids. The store is keyed by
dataset `id`; `updatedAt` is indexed for list ordering.

### 5.1 Repository contract

[`ExperimentalDatasetRepository`](../src/data/repositories/experimentalDatasetRepository.ts)
is the only persistence boundary:

- `list()` returns summaries sorted by `updatedAt` descending (name
  ascending on a tie) and separately reports unreadable rows as
  `{ id, message }`. Corrupt rows are never silently dropped, edited or
  deleted.
- `get(id)` reads and validates one complete record, or returns
  `NOT_FOUND` / `CORRUPT`.
- `create(input)` validates the input, assigns a new dataset id first and then
  a new id for every measurement, assigns one creation timestamp, validates
  the complete candidate record again, and writes it with `add` in a
  single-store read-write transaction. Nothing is partially written.
- `update(id, changes, expectedUpdatedAt)` supports name and/or notes only.
  Measurements, units, provenance and unknown stored fields are not changed.
  The current row is re-read and validated and the caller's `updatedAt` token
  is compared **inside the write transaction**. A mismatch returns `CONFLICT`
  and writes nothing. An absent `name` keeps the current name; absent `notes`
  keeps the current notes; explicit `undefined` clears them.
- `delete(id, expectedUpdatedAt)` re-reads, validates and compares the token
  inside its transaction. A stale token returns `CONFLICT`; a corrupt row
  returns `CORRUPT` and is not deleted.

`updatedAt` is the optimistic-concurrency token. It is not in the `.npex`
file. To avoid two updates receiving the same clock millisecond, the
repository makes each next `updatedAt` strictly greater than the previous
value (`previous + 1 ms` when necessary). Successful writes are atomic at
the Dexie transaction boundary.

Reads validate every record with the shared Zod schema. A row that fails
validation is reported as corrupt and cannot be selected for editing or
deletion through normal UI paths. Unknown fields on stored records are
tolerated by the persistence schema for forward compatibility; `.npex` is
strict at its own boundary.

### 5.2 Composition and UI state

The page receives a repository from the application composition root
(`src/app/experimentDatasetRepository.ts`). React components never import
Dexie. The feature's local hook
([`useExperimentalDatasetLibrary`](../src/features/experiments/useExperimentalDatasetLibrary.ts))
owns list status, selection, busy/feedback state and write intents. There is
no global Zustand store and no database access in the view.

---

## 6. Datasets page

Route: **`/experiments`**. Navigation label: **Experimental Data**. Page
heading: **Experimental Datasets**.

The page provides:

- a CSV import card with file choice, explicit mapping, declared units,
  preview counts/issues and an explicit confirm action;
- a `.npex` import card with read-only preview and explicit confirm;
- a saved-dataset list with measurement count and declared units, plus an
  unreadable-row report;
- a detail view with name, units, created/updated times, original import
  provenance, optional notes, ordered measurement table and chart;
- rename (name only in this phase) and a two-step confirmed permanent delete;
- export of the selected dataset as `.npex`;
- manual refresh.

The ordered measurement table is the accessible authority: it shows every
stored row, including duplicate times and exact replicates, in array order.
The chart is presentation-only:

- one marker trace, one marker per stored measurement, in source order;
- axis titles use the declared time and concentration units;
- no scientific calculation occurs in React or in the Plotly adapter;
- a fitted curve (§10) is drawn only after the user runs the fit, and only as a
  **separate line trace** beside the markers — it is never merged into the
  observed trace, and the measurement table remains the authority for measured
  values. The curve is a model visualization, not measured data.

The chart is lazy-loaded. UI tests stub it; the E2E suite exercises the real
Plotly rendering in Chromium. Both the measurement table and the controls are
keyboard-operable, and the page has been scanned with axe-core in empty,
mapping, preview, detail, rename and delete-confirmation states.

---

## 7. Recovery backup (`.npsb` 1.1.0)

The recovery archive now covers **all persistent scientific stores**:

- `drugs`
- `meta`
- `compounds`
- `observations`
- `scenarios`
- `experimentDatasets` (new in 1.1.0)

An exported 1.1.0 archive always emits all six arrays, including empty ones,
and all counts: `drugRows`, `readableAtExport`, `quarantinedAtExport`,
`metaRows`, `compoundRows`, `observationRows`, `scenarioRows` and
`experimentDatasetRows`. Export still performs one consistent snapshot and
fails closed with no file if any store cannot be read faithfully.

Older supported archives (including 1.0.0 with only `drugs` and `meta`) remain
restorable. For each additive store, the array and its count must either both
be present or both be absent; a one-sided pair is invalid. An absent pair is
treated as an empty store, emits an explicit `ARCHIVE_STORE_ABSENT` preview
warning, and full replacement **clears** that local store – silence is not
allowed for a destructive result. A 1.1.0 archive with an empty
`experimentDatasets` array restores an empty dataset store in the same way.

Restore remains one acknowledged, atomic full replacement. It clears and
rewrites all six stores plus the local revision table in a single `rw`
transaction: any validation error writes nothing, and any transaction failure
rolls back every store to its previous contents. Revision tokens are outside
the archive and every restored drug id receives a revision bump, preserving
the stale-write safeguards. See
[`docs/recovery-backup.md`](recovery-backup.md) for the full format and
failure contract.

A `.npsb` file is not a portable dataset interchange file. To move one
dataset between libraries or applications, use `.npex`; to move the complete
browser-local state, use `.npsb`.

---

## 8. Scientific and data-integrity boundaries

- **Measured, not fitted.** The page stores and plots observed values. It
  does not claim a model, estimate parameters, infer a terminal phase,
  calculate a half-life, or fill a missing point.
- **No silent cleaning.** Qualifiers and non-finite values are rejected, not
  coerced. Rows are never dropped to make a file importable.
- **No implicit identity.** `sourceRow` is source provenance. Local dataset
  and measurement ids are separate; `.npex` never carries them.
- **No implicit units.** Every dataset has both units before its first write.
  Display and plotting reuse the declared strings.
- **No implicit source.** Provenance is shown as originally supplied. A
  re-import does not invent a new scientific source.
- **No hidden write.** Import previews are read-only; writes occur only after
  explicit confirmation, through the repository, in validated transactions.
- **Derived analysis never rewrites evidence.** Phase 47B fitting (§10), the
  Phase 47C residual/RMSE diagnostics (§11), the objective profile (§12), the
  two-candidate comparison with its conditional AICc (§13), the residual
  structure views (§14), the proportional-variance likelihood path (§15) and
  noncompartmental analysis (§16) are temporary derived views; imports, stored
  observations, and `.npex` round trips are unchanged.
  RMSE is descriptive and has no universal pass/fail threshold. Each AICc is
  conditional on its own explicitly declared error model, the two criteria are
  never compared with each other, and each ranks only the two configured
  candidates. Formal identifiability tests and parameter uncertainty estimates
  still need contracts and assumptions of their own.

---

## 9. Verification map

| Layer | Representative files | Coverage |
| --- | --- | --- |
| Domain — NCA | `src/domain/experiments/nca.test.ts` | linear and logarithmic trapezoids against hand-calculated values; linear-up/log-down per interval direction and its linear fallback; Cmax/Tmax with the earliest-time tie; AUC0-last naming and the not-from-zero case; λ_z / t½ / AUC∞ against exact exponential data; duplicate-time and non-positive-terminal unavailability; a trailing zero; invalid measurements; input-order invariance and non-mutation; terminal selection |
| Domain | `src/domain/experiments/experimental-dataset.test.ts`, `src/domain/experiments/mono-exponential-fit.test.ts`, `src/domain/experiments/mono-exponential-fit-diagnostics.test.ts`, `src/domain/experiments/mono-exponential-profile.test.ts`, `src/domain/experiments/mono-exponential-baseline-fit.test.ts`, `src/domain/experiments/mono-exponential-model-comparison.test.ts`, `src/domain/experiments/proportional-variance-fit.test.ts`, `src/domain/experiments/proportional-variance-comparison.test.ts` | dataset contract, bounded fit/failures, raw residuals/RMSE, row fidelity and limited data-support notes, the objective profile, constrained M1 recovery/boundaries/degeneracy, the common-variance comparison with its AICc gates, and the proportional-variance likelihood: closed-form profile arithmetic against independent values, likelihood-vs-weighted-SSE separation, parameter recovery, unit scaling, zero-observation rejection, degenerate dispersion, boundary labels, parameter counts and every AICc gate |
| Schemas | `src/data/schemas/experimentalDatasets.test.ts` | input/record/`.npex` shapes, limits, negative/non-finite rejection, units, duplicate measurement ids |
| CSV | `src/features/experiments/csvDataset.test.ts` | explicit mapping, RFC 4180 reuse, row-specific errors, qualifiers, duplicates/order, all-or-nothing |
| `.npex` | `src/data/npex/npex.test.ts` | envelope/version rules, strict shape, duplicate keys, depth/size, round trip, local identity absent |
| Repository | `src/data/repositories/dexieExperimentalDatasetRepository.test.ts` | CRUD, validation on read/write, corruption reporting, atomicity, optimistic tokens, immutable science, strict timestamp ordering |
| Database/recovery | `src/data/db/database.test.ts`, `experimentalDatasetRecovery.test.ts`, `archive.test.ts` | v5→v6 preservation, all-store snapshot/restore, legacy absent-store warnings/clearing, rollback |
| UI — NCA | `src/features/experiments/NcaCard.test.tsx`, `src/features/experiments/ExperimentalDatasetsView.test.tsx` | parameter table with units and kind, interval naming, method/terminal-point switching, duplicate-time and non-positive-slope unavailability, terminal diagnostics, and presence without a fit |
| UI | `src/features/experiments/*.test.tsx`, `src/components/charts/experimentalDatasetAdapter.test.ts`, `src/components/charts/ExperimentalFitResidualChart.test.tsx`, `src/components/charts/ExperimentalFitResidualVsFittedChart.test.tsx`, `src/components/charts/ExperimentalFitProfileChart.test.tsx` | import/preview/confirm, table, observed/fitted chart, residual plots against time and fitted value, RMSE and screening states, residual-spread states, objective-profile chart labelling and empty/invalid-candidate states, comparison table/parameter counts, AICc gating on the declared assumption, unavailable/insufficient/zero-variance states, the second error model's own declaration and re-fitted table, degenerate and small-sample states, declaration reset on dataset change, rename/delete/export/error states |
| Browser | `e2e/experimentalDatasets.spec.ts`, `e2e/a11y.spec.ts` | real Chromium CSV→chart→`.npex`→re-import, persistence, recovery, fit overlay, residual plot/RMSE/data-support screen, objective profile after fitting plus its sparse-data and stale-fit states, comparison with AICc unavailable→declared and an undersized sample, residual structure for both models with real-Plotly axis titles, marker counts and duplicate-timestamp disclosure, the proportional-variance declaration gate and its re-fitted table, narrow layout and axe scans |

The full matrix and gate commands are maintained in
[`docs/testing.md`](testing.md).

## 10. One-compartment mono-exponential fit (phase 47B)

The datasets page can fit a constrained decay model to the **selected**
dataset:

    C(t) = C_ref · exp(−k · (t − t_ref)),   t_ref = min(t_i),  k ≥ 0

- **Reference time.** `t_ref` is the earliest observed time, so a dataset need
  not contain a measurement at zero. `C_ref` is the fitted concentration *at*
  `t_ref`, in the dataset's declared concentration unit — never an observed
  value and never a claimed initial concentration unless `t_ref = 0`.
- **Rate and half-life.** `k` is in the reciprocal of the dataset's declared
  time unit; the half-life is `ln(2)/k` when `k > 0`, and is reported as absent
  at the zero-rate boundary.
- **Objective.** Unweighted least squares on the ORIGINAL concentration scale.
  There is no log transform, so zero concentrations are valid observations.
  Every row contributes independently: repeated timestamps and exact
  replicates are never averaged, deduplicated, sorted or dropped.
- **Optimizer.** Variable projection over normalized time
  `u = (t − t_ref)/T` with `T = max(t) − min(t)`, optimising the
  dimensionless rate `q = k·T`. For each trial `q` the amplitude has the closed
  form `C_ref(q) = max(0, ΣC_i g_i / Σg_i²)` with `g_i = exp(−q·u_i)`; the
  search is a deterministic coarse scan over `q ∈ [0, 50]` followed by
  golden-section refinement, with both endpoints checked explicitly.
  Concentrations are scaled by their maximum before the normal equations and
  rescaled afterwards, so extreme magnitudes cannot overflow.
- **Algorithm constant.** `q = 50` is a named numerical bound, not a
  scientific assumption. An optimum at that bound is reported with an explicit
  warning that the rate is unresolved beyond it.

### Eligibility and boundary behaviour

| Case | Outcome |
| --- | --- |
| Empty input, non-finite or negative values | structured failure |
| One distinct time value | failure: the rate is not identifiable |
| All concentrations zero | failure: the rate is not identifiable |
| Optimum at `k = 0` (constant or increasing data) | success with a
  zero-rate-boundary warning and no finite half-life |
| Optimum at the upper numerical bound | success with an unresolved-rate
  warning |

Failures carry a typed code and an explanatory message, never a placeholder
rate or half-life. No `Infinity` or `NaN` is ever rendered as a fitted value.

### What the chart shows

The fitted curve is drawn as a **separate line trace** beside the observed
markers, sampled only inside the observed time range — there is no
extrapolation. It is a visualization of the fitted equation, not additional
measurements and not an interpolation of the stored rows. The measurement
table remains the accessible source of the observed values.

### Boundaries

A fit is a **derived, ephemeral result**: it is never written to the dataset,
its measurements, IndexedDB, `.npex` or `.npsb`, and running a fit performs no
repository write. Switching datasets (or any change to the dataset's
`updatedAt`) discards the previous fit so a stale result cannot be read against
different data. Re-fitting an unchanged dataset is deterministic.

A converged optimization is a numerical result, not evidence that a
mono-exponential decay describes the data. The model cannot represent a rising
curve, an absorption phase, a baseline offset or multiple kinetic phases.
Raw residuals, RMSE and an explicitly preliminary data-support screen are now
available in §11, an objective-shape screen in §12 and residual-structure views in
§14. Parameter uncertainty,
confidence intervals, R², formal identifiability analysis and model comparison
remain unimplemented.


## 11. Fit quality diagnostics (initial Phase 47C slice)

When a successful fit is available, the page derives one residual for every
stored measurement:

    residual_i = observed_i − fitted_i
    RMSE = sqrt(Σ residual_i² / n)

- **Original scale and units.** Residuals and RMSE use the declared concentration
  unit and the same unweighted least-squares fit on the original concentration
  scale. Residuals are not log-transformed or standardized.
- **Row fidelity.** The residual plot contains one marker per measurement,
  preserves source-row order and duplicate timestamps, and identifies the
  source row on hover. The horizontal zero line represents a zero residual.
  The original measurement table remains the record of observed data; neither
  residuals nor fitted values are written to IndexedDB, .npex or .npsb.
- **No universal cutoff.** RMSE is a descriptive error magnitude, not a
  goodness-of-fit verdict. Its interpretation depends on the measurement scale,
  error process and intended use. The UI intentionally does not color it as
  pass/fail or infer that a model is scientifically suitable.
- **Residual degrees of freedom.** The page reports n − 2 for this model's
  two fitted parameters (reference concentration and decay rate). When the
  count is zero, it states that there is no residual degree of freedom and
  does not estimate residual variance.
- **Preliminary data-support screen.** Boundary estimates (k = 0 or the
  optimizer's numerical upper bound), fewer than three distinct time points,
  and zero residual degrees of freedom are called out. This is a transparent
  screening aid only; three or more time points do not prove practical
  identifiability, and this screen is not a formal identifiability test.
- **Still deliberately absent.** No standardized residuals, R², standard
  errors, confidence intervals, likelihood, alternative-model ranking, AIC or
  AICc are generated. Model comparison requires multiple candidate models fit
  to the same observations and a declared error/likelihood model. AICc must not
  be reported until those assumptions, parameter counts, sample-size limits
  and failure behaviour are implemented and tested. The objective-shape screen
  in §12 is a practical screening aid and adds no probabilistic quantity.

Tests use synthetic values only. The diagnostics function is pure and only
accepts a successful fit; a mismatch between the current measurements and the
fit's observation count produces a structured failure rather than displaying
stale or misaligned residuals.

## 12. Practical identifiability screen (Phase 47C, second slice)

After a **successful** fit the page also profiles the fit's own objective over
candidate decay rates, to describe whether that objective localizes the rate
or leaves many rates nearly equivalent. It is an additional diagnostic: the
fit, its estimator, its stopping rule and its reported parameters are
unchanged.

### 12.1 What is actually profiled

The fitted model has **one** parameter in its nonlinear search. Writing
`T = max(t) − min(t)` and `q = kT`, the objective at a trial rate is

    RSS(k) = Σ_i [ c_i − C_ref(k) · exp(−k (t_i − t_ref)) ]²
    C_ref(k) = max(0, Σ_i c_i g_i / Σ_i g_i²),   g_i = exp(−k (t_i − t_ref))

The amplitude is **concentrated out** by the same non-negative variable
projection the optimizer uses — it is not held fixed, and it is not a second
grid dimension. The screened quantity is therefore a *profile of the
least-squares objective* in the single rate parameter, which is exactly the
objective the estimator minimizes.

Both modules go through one shared normalization (`prepareObjective` in
`mono-exponential-fit.ts`, exposed as `createMonoExponentialObjective`), so the
diagnostic can never be computed against a different objective, a different
scaling, or a different `t_ref` than the one that produced the estimate.

The estimate and its `sse` are reported **verbatim**. The screen never
re-optimizes and never substitutes a candidate rate for the estimate. The
optimizer stops on a relative tolerance, so a candidate rate can occasionally
evaluate a few ulps *below* the reported `sse`; that difference is numerical
and is never used to replace the reported result.

### 12.2 The evaluation grid

Candidate rates are evaluated over the same admissible interval as the fit,
`q ∈ [0, 50]` (`k ∈ [0, 50/T]`). The grid is **deliberately non-uniform**:

| Segment | `q` range | Step | Points |
| --- | --- | --- | --- |
| Dense | 0 – 10 | 1/12 | 121 |
| Sparse | 11 – 50 | 1 | 40 |

The non-uniformity is a **display decision, not a scientific claim**: the
reported estimate never comes from this grid, and the whole admissible
interval is still covered so a flat tail or an estimate at the numerical cap
stays visible. Denser sampling where a decay of practical interest lives keeps
the near-minimum region legible instead of compressing it into the first
fraction of a 0–50 axis.

Each evaluation costs `O(n)` for `n` stored rows, so one screen is
`O(161 · n)` — linear in the dataset and independent of row order.

### 12.3 How the shape is described

The near-minimum band is the set of evaluated rates whose objective is within
a documented relative increase over the estimate's own value:

    RSS(k) ≤ RSS(k̂) · (1 + 0.5)

**Why this one and not the improvement over `k = 0`.** A tolerance scaled by
the attainable improvement is dominated by the strongest residual in the
dataset — a single outlier at the reference time makes almost every rate look
equivalent. The relative-increase form is local to the minimum and asks a
question about the fit itself: *how much worse does the residual get if the
rate is forced away?*

**It is a heuristic, and it is documented as one.** A 50 % increase in a sum of
squares is a ≈ 22 % increase in residual magnitude (`√1.5 ≈ 1.22`), so rates
that worsen the unweighted residual by about a fifth or more are treated as
distinguishable. It carries **no coverage probability**; with a declared error
model it would not correspond to any particular interval either. The
coefficient lives in `NEAR_MINIMUM_RSS_FRACTION` with this rationale.

The classification is then:

| `localization` | Condition |
| --- | --- |
| `boundary-zero-rate` | The estimate is exactly at `k = 0` |
| `boundary-upper-rate` | The estimate reached the optimizer's numerical cap |
| `localized` | Band width ≤ 10 % of the admissible interval (`BROAD_BAND_FRACTION`), or the band is narrower than the grid step |
| `broad` | Band width > 10 % of the admissible interval: many rates are nearly equivalent |
| `indeterminate` | The band is truncated by a bound, too few distinct times exist, or no improvement over `k = 0` was found |

A band narrower than the grid step is reported as `narrower-than-grid` and
classified `localized`: the gap only means the objective rises steeply on both
sides of the estimate. A band **truncated by a bound** is classified
`indeterminate` instead, because its width is not a measure of the objective's
shape.

### 12.4 Boundary proximity

Two different, individually justified tests are used — no universal
"identifiability threshold" is introduced:

- **Lower bound.** `q` is the decay exponent across the whole observed span, so
  the fitted model predicts a fractional decline of `1 − e^(−q)`. At
  `q < 0.02` that decline is under ≈ 2 %, and the estimate is reported as
  *close to the zero-rate boundary*. The threshold therefore states a property
  of the fitted curve rather than a distance in parameter space.
- **Upper bound.** At 98 % of the numerical cap the exponential has fallen to
  `e^(−49) ≈ 5e−22`, so the objective is numerically identical to its value at
  the cap either way. `q ≥ 49` is reported inside the unresolvable band; the
  exact-cap warning still comes from the fit itself.

A distance measured as a fraction of the 0–50 search interval would be
misleading here: `q = 1` is 2 % of that interval yet describes 63 % decay
across the window — an ordinary, well-supported rate.

### 12.5 Data sufficiency

The screen needs at least **three distinct measured times** (`MINIMUM_DISTINCT_TIMES`,
matching the §11 note). Below that, residual patterns cannot separate a wrong
shape from noise, so no shape classification is reported even when the band is
narrow. Replicate rows at the same time increase `n` and the residual degrees
of freedom but not the distinct-time count, and they remain separate
observations everywhere.

### 12.6 Failed evaluations are reported, never filled in

A candidate that cannot be evaluated — its rate is not representable for this
time span, or an intermediate is non-finite — is returned as an explicit failed
point with a reason (`NON_FINITE_RATE`, `NON_FINITE_OBJECTIVE`). The screen
counts them, states the count, and never interpolates, clamps or drops them
silently. The chart omits them; the summary says how many of the candidates are
unavailable. If *no* candidate can be evaluated, the screen returns a
structured failure and the UI shows it as a state rather than as a number.

### 12.7 What this screen is not

- **Not a structural-identifiability analysis.** Structural identifiability is a
  property of the model structure given perfect data. This screen is a property
  of one objective on one dataset. Passing it proves nothing structural.
- **Not a likelihood profile.** A sum-of-squares profile becomes a likelihood
  profile only under a declared error model; none is declared. The UI and the
  chart label say "residual sum of squares" and state explicitly that this is
  not a likelihood or profile likelihood.
- **Not a confidence interval, standard error, or coverage statement.** No
  probabilistic quantity is produced.
- **Not a model comparison.** Only this model's own rate parameterization is
  evaluated. No AIC, AICc, F-test, likelihood-ratio test or alternative model
  appears.
- **Not a verdict.** There is no pass/fail badge, no R², and no claim that a low
  RMSE or a narrow band proves the model appropriate.

The unweighted objective also assumes that every observation is equally
uncertain on the original concentration scale. That assumption is not tested
here and is listed among the screen's standing limitations wherever it is
shown.

### 12.8 How it is displayed

The screen appears as its own card in the selected-dataset view, **only after a
successful fit** — never before one, and never against a failed fit. It shows:

- the classification in plain language, with no colour-coded verdict;
- the number of candidate rates evaluated and how many were unavailable;
- the near-minimum band as an interval in the dataset's declared reciprocal
  time unit, or the explicit "narrower than the grid"/"not defined" state;
- the estimate's position relative to the bounds;
- a **lazy-loaded** Plotly chart of the objective against `k`, labelled
  `Decay rate k (<time unit>⁻¹)` and `Residual sum of squares ((<concentration
  unit>)²)`, with the fitted estimate as a separate marker trace;
- the dataset-specific warnings and the standing limitations, both in plain
  language.

Measured data, the fit result and the diagnostics stay visually and structurally
distinct: the measurement table remains the accessible authority, the fitted
curve is a separate line trace, and the profile is a separate card.

### 12.9 Boundaries

Like the fit, the screen is **derived and ephemeral**: no candidate rate, band,
classification or chart datum is written to the dataset, its measurements,
IndexedDB, `.npex` or `.npsb`. It is not persisted, not exported and not part of
the experimental dataset schema. Switching datasets discards it with the fit.
Tests use deterministic synthetic values with known rates; no test asserts exact
floating-point formatting or grid internals.

## 13. Two-candidate model comparison with a conditional AICc (Phase 47C)

When a successful M0 fit exists, the page also fits **one** alternative and
compares the two. The comparison is transparent accounting, not an automatic
determination of the true pharmacokinetic mechanism.

### 13.1 Candidate set

| Id | Model | Mean-model parameters |
| --- | --- | --- |
| M0 | `C(t) = A · exp(−k · (t − t_ref))` | `A ≥ 0`, `k ≥ 0` — 2 |
| M1 | `C(t) = B + A · exp(−k · (t − t_ref))` | `A ≥ 0`, `B ≥ 0`, `k ≥ 0` — 3 |

M0 is the existing production fit, **reused verbatim**: its estimate, `sse`
and warnings are reported as computed, never re-derived here.

M1 adds an additive baseline. It can represent a plateau the decay does not
reach, a persistent background reading or a model-form mismatch. A baseline
is a **shape, not a cause**: nothing in this comparison establishes a
physiological or analytical origin for it.

There are exactly two candidates. A third model (for example a
bi-exponential decay) is deliberately out of scope for this increment.

### 13.2 How M1 is fitted

For a fixed dimensionless rate `q = k·span`, with `g_i = exp(−q·u_i)`, the
amplitude and baseline subproblem is a two-variable non-negative least
squares problem. It has three faces — both coefficients free, `A = 0`, and
`B = 0` — and because every observed concentration is non-negative the two
single-coefficient faces are always feasible (`B = mean(c)` and
`A = Σ c g / Σ g²`). The constrained optimum of a convex quadratic on two free
variables must lie on one of the three, so **enumerating the faces and keeping
the lowest sum of squares is exact**: no iterative solver, no tolerance-
dependent stopping rule, and no possibility of a negative coefficient.

Two numerical details matter:

- **The 2×2 determinant is guarded.** `det = n·Σg² − (Σg)²` vanishes
  quadratically as `q → 0`, where a decay and a constant are indistinguishable.
  Below a documented relative floor the unconstrained candidate is skipped and
  the constrained faces decide — which is the correct answer in that limit,
  and reports `A = 0` with `B = mean(c)` rather than an arbitrary pair.
- **The reported objective is recomputed from the residuals**, never from the
  normal equations, so a near-perfect fit cannot return a small negative sum
  of squares or hide cancellation error.

The rate search mirrors M0 exactly: a deterministic coarse scan over
`q ∈ [0, 50]` (201 points), a golden-section refinement inside the bracket
around the best scanned point (the same shared routine), and an explicit
comparison against both endpoints. **A coarse-grid value is never published as
the estimate.**

### 13.3 Comparison fairness

Both models are constructed from the same normalized problem — one shared
preparation (`prepareMonoExponentialProblem`) supplies the rows, `t_ref =
min(t)`, the observed span and the concentration scaling to both. They
therefore use:

- the same measurement rows and the same set of observations (no point is
  excluded for looking unrepresentative);
- the same original concentration scale and no transformation;
- the same unweighted objective (no weighting, no log scale);
- the same treatment of duplicate timestamps and replicates — every row is an
  independent contribution, so a duplicated row genuinely carries extra
  weight;
- the same definition of `t_ref`.

Nothing is sorted, averaged, deduplicated, mutated or persisted.

### 13.4 Descriptive comparison

Both models are reported with comparable quantities: model identity,
equation, fitted parameters **with their unit kind** (concentration or
reciprocal time, resolved to the dataset's declared units), SSE in
`(concentration unit)²`, RMSE in the concentration unit, the number of
observations actually used, the number of mean-model parameters, and the
total parameter count `K` used by the criterion. Boundary and convergence
warnings are carried through.

Parameter counting follows the **model**, not the optimizer. M1's amplitude is
obtained by variable projection inside each rate trial, but it is still an
estimated model parameter, so M1 has three mean-model parameters. The
information criterion additionally counts one residual-variance parameter:
`K(M0) = 3`, `K(M1) = 4`.

The comparison never awards a winner. A model with more parameters can reduce
the residual sum of squares by construction, and the UI says so explicitly.

### 13.5 Error-model contract

The only supported assumption is:

> **Independent additive Gaussian errors with a common variance on the original
> concentration scale.**

The analyst must **explicitly declare** it before any AICc is computed; the
declaration starts unchecked, and no default exists. Declaring it is an
assumption, **not evidence**: the data do not establish that residuals are
independent, Gaussian or equally uncertain, and nothing here tests that.

Until the declaration is made, the descriptive comparison remains fully
available and AICc is reported as unavailable, with the reason shown.

### 13.6 Conditional AICc

With `n` observations, residual sum of squares `SSE`, and `K` total estimated
likelihood parameters (mean-model parameters plus one variance):

    AIC  = n · ln(2π) + n + n · ln(SSE / n) + 2K
    AICc = AIC + 2K(K + 1) / (n − K − 1)

This is the ordinary Gaussian likelihood evaluated at the least-squares
estimate with `σ² = SSE/n`. The maximized log-likelihood
`−(n/2)·[ln(2π) + ln(SSE/n) + 1]` is exposed alongside the criterion so
`AIC = −2·lnL + 2K` can be checked.

AICc is returned as **unavailable**, with a structured reason, when:

| Condition | Reason |
| --- | --- |
| No error model declared | `ASSUMPTION_NOT_DECLARED` |
| That candidate's fit failed | `FIT_UNAVAILABLE` |
| `SSE` is not finite | `NON_FINITE_SSE` |
| `SSE` is zero (degenerate variance) | `ZERO_RESIDUAL_VARIANCE` |
| `n − K − 1 ≤ 0` | `INSUFFICIENT_OBSERVATIONS` |

A zero SSE is **never** replaced by an arbitrary epsilon, and ordinary AIC is
**never** substituted for AICc. The per-model gate matters in practice: with
five observations, M0 (`K = 3`) still satisfies `n − K − 1 = 1` while M1
(`K = 4`) does not.

### 13.7 Interpretation and limitations

- Lower AICc is **relative support within these two candidates under the
  declared error model**. It is not proof of the true mechanism, and it says
  nothing about a model that is not in the candidate set.
- AICc is conditional on the declared assumption; it does not test it.
- The difference `AICc(M1) − AICc(M0)` is displayed as arithmetic only. **No
  threshold, model weight, probability or verdict is applied**, and none
  should be inferred from it.
- Constrained boundary estimates and nonlinear fitting weaken the
  regular-likelihood assumptions behind information criteria. Boundary
  estimates are reported and flagged, and the comparison is explicitly less
  reliable when they appear.
- No hypothesis test, confidence interval, standard error, model weight or
  third candidate is produced.

### 13.8 Interface

The comparison is its own card in the selected-dataset view, shown only after
a successful M0 fit, and only after the fit itself — the measured-versus-fitted
chart, residual diagnostics and identifiability screen are untouched.

It contains: the error-assumption declaration with its caveat, a table of the
quantities above (one column per model), the AICc row, the difference line, the
per-model reasons whenever AICc is unavailable, any fit warnings from either
candidate, and the standing limitations. Unavailable criteria read
`unavailable` — never `NaN`, `Infinity`, a fabricated score or a zero.

### 13.9 Boundaries

The comparison is derived and ephemeral, like the fit: no parameter, SSE,
criterion or declaration is written to the dataset, its measurements,
IndexedDB, `.npex` or `.npsb`. Changing the declaration recomputes only the
criterion — neither model is re-fitted. Switching datasets discards both.

## 14. Residual structure and spread screening (Phase 47C)

For every candidate that produced a successful fit, the page shows the same
residuals two ways and screens their spread. Both candidates are described from
the fits that already exist — M0's residual diagnostics and the M1 fit the
comparison produced — so no model is fitted again for a plot.

### 14.1 The two views

    residual_i = observed_i − fitted_i

on the original concentration scale, in the dataset's declared concentration
unit.

| View | Horizontal axis | What it makes visible |
| --- | --- | --- |
| Against measured time | time (`timeUnit`) | drift, level shifts, curvature that the model cannot follow |
| Against fitted concentration | fitted concentration (`concentrationUnit`) | changing spread, curvature and systematic bias, because both axes share one scale |

Both plots draw one marker per stored measurement and a horizontal zero line
that represents a perfect prediction. **Markers are deliberately not
connected.** The observations are not a continuous time course, are not
guaranteed to be equally spaced, and plotting them in measured-time order says
nothing about dependence between them.

Hover text carries the source row, the measurement time, the observed value,
the fitted value and the residual, so any point can be traced back to the row
it came from.

### 14.2 Identity, replicates and ordering

- Every stored row contributes exactly one point. Duplicate timestamps and
  exact replicates remain separate points with separate residuals; none is
  averaged, dropped or merged.
- Nothing is sorted, rewritten or persisted. The charts place each point at its
  measured time, and the measurement table remains the authority for the stored
  values.
- When rows share a timestamp, the section says how many do.
- When the stored source order is not non-decreasing in time, the section says
  so, so nobody reads a left-to-right "sequence" into a chart that was never
  stored in that order.

### 14.3 What cannot be inferred from ordering

**No autocorrelation, independence test or effective-sample-size adjustment is
computed.** The dataset carries no sampling schedule, no subject identifier that
guarantees a single series, and no guarantee that rows are complete or equally
spaced. A lag-one correlation across such rows would be a number with no
defensible interpretation. The section therefore reports the limitation instead
of inventing an independence test, and the same sentence appears in every
model's notes.

### 14.4 Residual-spread screen

A conservative, descriptive screen for a spread that changes with the fitted
level:

1. The observations are split into two halves of the **fitted** range by a
   deterministic **count-based** split: a copy of the indices is sorted by
   fitted value and divided by position, so the stored rows are never
   reordered.
2. The mean absolute residual of each half is reported, with the group counts.
3. The screen compares the larger mean with the smaller one.

**The split is a cut through the sample, not two natural groups.** Because it
is count-based it can land inside a run of identical fitted values — which
happens routinely when several rows share a timestamp, since they share a
fitted value too. The result therefore reports both edges of the cut
(`splitFittedValue`, `upperFirstFittedValue`) and a `boundaryTies` flag:
when the two edges are equal, the section says explicitly that the groups
**overlap at the split** and that this is not two strictly separated
fitted-value ranges. When they differ, it says the groups are separated while
still noting that the boundary is arbitrary.

| Status | Condition |
| --- | --- |
| `visible-pattern` | The larger mean is at least **2×** the smaller, or one half is exactly zero while the other is not |
| `no-visible-pattern` | The halves differ by less than that ratio |
| `inconclusive` | Every residual is zero, so there is no spread to compare |

The screen is **unavailable** (`ok: false` with a typed code) when there are
fewer than **6** observations (three per half), when every fitted value is
identical so the fitted range cannot be split, or when a fitted value or
residual is not finite. The residuals themselves remain available in all three
cases — only the screen is withheld.

**What the screen actually measures.** It compares the observed mean absolute
residual of two groups of rows in this one dataset. That is a difference
between two sample summaries — nothing more. It does not estimate a variance,
does not establish heteroscedasticity, and does not identify the cause of a
difference: a mean model that misses structure, a level shift, or a few
unusual observations can all widen one half.

**The constants are screening conventions, not tests.** The twofold ratio is a
deliberately coarse trigger chosen so that ordinary scatter in a small sample
is not flagged; it is not derived from a sampling distribution and carries no
probability statement. Six observations is the smallest sample that gives two
halves worth comparing. Neither is a universal threshold, and a ratio below the
trigger is not evidence that the spread is constant. Both means, both counts
and the ratio are shown next to the finding so the reader can judge the
evidence directly.

### 14.5 How this relates to the conditional AICc

The declared error model includes a **common variance**. A visible difference
between the two halves therefore raises a concern about that part of the
assumption for these data — but it does not establish that the assumption is
false. Mean-model misspecification, a level shift or a few unusual
observations can widen one half without any change in the error variance, and a
two-group summary cannot separate those explanations.

The application responds in exactly one way: the comparison section displays a
caveat naming the models whose screen found a visible difference and stating
that the criterion is harder to interpret for these data, while saying that the
pattern does not establish that the assumption is false. It **does not**:

- change, recompute or hide the criterion;
- silently substitute a weighted or different error model;
- treat the screen as proof that the assumption is wrong.

A patternless screen changes nothing either: AICc stays conditional on the
declared assumption, and the absence of a visible difference is not evidence
that the assumption holds. Neither outcome creates a winner, a verdict or an
automatic model choice.

### 14.6 What these views cannot establish

- **Gaussianity.** Residual shape cannot confirm a normal error distribution,
  and a symmetric-looking cloud does not establish one.
- **Independence.** Points are not a time series here; nothing in these views
  speaks to correlation between observations.
- **Constant variance.** The screen describes two halves of one sample.
- **Model adequacy.** A patternless plot is consistent with the model but does
  not prove it, and a visible pattern does not identify its cause (wrong model
  form, a level shift, an outlier, or a different error structure).

These are descriptions of one dataset. They are screening aids, not formal
tests.

### 14.7 Interface and boundaries

The section is its own card, shown only after a successful fit, with one
labelled block per candidate model. Each block carries its observation count,
RMSE, distinct-time count, the spread finding, both plots and the ordering
notes. A candidate whose fit failed is reported as unavailable rather than
omitted silently.

Charts are lazy-loaded; each figure has a caption and an accessible
description naming both axes, the units, the zero line and the fact that
markers are not connected. The section adds no persistence: no residual, fitted
value, screen status or ordering note is written to the dataset, its
measurements, IndexedDB, `.npex` or `.npsb`.

## 15. A second error model: variance proportional to the mean (Phase 47)

The comparison in §13 is conditional on one variance assumption. A residual
spread pattern (§14) may raise concern about it, but the application must never
silently switch models. This section adds a **separate, opt-in** likelihood
path with its own declaration, its own fits and its own criterion. It is never
mixed with the common-variance results.

### 15.1 The statistical contract

    Y_i | t_i  ~  Normal( μ_i , φ · μ_i ),   independent across i
    μ_i = μ(t_i; θ) > 0,   φ > 0

`φ` carries the **concentration unit**: the variance φ·μ then has units of
concentration squared, as it must. It is a dispersion parameter of the variance
function, not the residual variance of the common-variance model.

The mean models are unchanged:

| Id | Mean model | Mean parameters |
| --- | --- | --- |
| M0 | `C(t) = A · exp(−k · (t − t_ref))` | `A`, `k` |
| M1 | `C(t) = B + A · exp(−k · (t − t_ref))` | `A`, `B`, `k` |

The complete log-likelihood for one candidate is

    −2 lnL = n·ln(2π) + Σ_i ln(φ μ_i) + Σ_i (y_i − μ_i)² / (φ μ_i)

For fixed mean parameters the maximiser over φ is closed-form,

    φ̂ = (1/n) Σ_i (y_i − μ_i)² / μ_i,

and substituting it gives the profile quantity this implementation optimises:

    −2 lnL̂ = n·ln(2π) + n·ln(φ̂) + Σ_i ln μ_i + n.

**The log-variance term is not optional.** Minimising Σ (y−μ)²/μ alone is a
different objective: it omits `Σ ln μ_i`, which depends on the mean parameters.
Every fit here maximises the likelihood above, and every reported criterion is
computed from `−2 lnL̂` — never from a weighted sum of squares.

**Parameter counting.** From the statistical model, not from the optimizer:

| Candidate | Mean parameters | Dispersion | Total `K` |
| --- | --- | --- | --- |
| M0 | 2 (`A`, `k`) | 1 (`φ`) | **3** |
| M1 | 3 (`A`, `B`, `k`) | 1 (`φ`) | **4** |

M0's amplitude is obtained from a closed form at each trial rate and M1's from a
closed form at each `(rate, λ)`; both are still estimated model parameters.

### 15.2 Valid domain and degeneracies

#### Zero observations

A zero observed concentration is **valid**. For any strictly positive
prediction its Gaussian density is finite, with contribution
`ln(φμ) + μ/φ`; the contribution diverges only as μ → 0. Whether that makes the
*joint* likelihood unbounded depends on the mean model and on the other rows, so
the two candidates are analysed separately.

**M0** (`μ_i = A·exp(−q·u_i)`). Driving one observation's prediction to zero
requires `q → ∞`, because `A` is pinned by the positive rows. That also drives
every other `u > 0` prediction to zero:

- If **any** observation after the first time is positive, its residual term
  grows like `y²/μ` and the deviance diverges to `+∞`. That rules out the
  unbounded-tail sequence as `q → ∞`, but not every degeneracy: exact-fit
  degeneracy, where the dispersion tends to zero, is handled separately below.
  Example (used as a test): `100, 20, 0`
  at times `0, 1, 2` has its maximum at `q ≈ 3.674`, `A ≈ 101.294`,
  `φ ≈ 1.171`, `lnL ≈ −8.6649` — verified against an independent numerical
  reference.
- If **every** observation after the first time is exactly zero, nothing
  constrains the tail: `φ̂` tends to a finite value while `Σ ln μ_i → −∞`, so
  the deviance diverges to `−∞` and the likelihood increases without bound. No
  finite MLE exists.

**M1** (`μ_i = B + A·exp(−q·u_i)`). With `B > 0` every prediction is `≥ B > 0`,
so no single contribution can diverge. The unbounded configuration appears only
along `B → 0` with `q → ∞`, which reduces to the M0 case. The criterion is
therefore identical for both candidates.

The implementation rejects exactly that configuration, with
`UNBOUNDED_LIKELIHOOD`. It is not reported as a boundary fit at the numerical
rate cap, and it is not rescued with a variance floor, a clamped prediction or
an epsilon. Every other dataset containing zeros is fitted normally. A zero at
the reference time with positive rows later is also valid: the later rows pin
the amplitude, so the rate may collapse to `q = 0`, which is a reported
boundary.

#### Other domain constraints

- **Every predicted concentration must be strictly positive and finite.** A
  candidate that cannot satisfy this fails with `NON_POSITIVE_PREDICTION`
  rather than being clamped.
- **A numerically zero dispersion is a failure.** If a candidate reproduces the
  observations to floating-point resolution, φ̂ is at machine precision and the
  likelihood has no finite maximum. The fit fails with
  `DEGENERATE_DISPERSION`; nothing is substituted for the missing variance.
- Underflow, non-finite intermediates and a non-representable rate are
  structured failures, never published numbers.

The all-zero dataset is rejected earlier by the shared validation
(`ALL_ZERO_CONCENTRATIONS`), and an empty or single-time dataset is rejected
with the same codes the production fit uses.

### 15.3 How the two candidates are fitted

**M0.** At a fixed dimensionless rate `q = k·span`, with `g_i = exp(−q u_i)`,
the profile likelihood is maximised exactly at

    A = Σ y_i / Σ g_i.

The implementation then searches `q ∈ [0, 50]` with a deterministic coarse scan,
golden-section refinement inside the bracket of the best scanned point, and an
explicit comparison against both endpoints. A coarse-grid value is never
published.

**M1.** Write `μ_i = m·h_i` with `h_i = (1−λ) + λ g_i`, `m = A + B > 0` and
`λ = A/(A+B) ∈ [0, 1]`. At fixed `(q, λ)` the profile is maximised exactly at

    m = Σ y_i / Σ h_i,

leaving a one-dimensional profile in λ. The implementation runs a global
two-dimensional coarse scan over `(q, λ)`, refines with golden-section searches
along each coordinate until the objective stops improving (capped), and then
re-solves λ conditionally at the published rate. Both endpoints λ = 0 (constant
mean) and λ = 1 (no baseline) are always evaluated, as are q = 0 and q = 50.
A coarse-grid value is never published as an estimate.

Both models are built from the shared preparation used by the production fit,
so they use the same rows, `t_ref = min(t)`, observed span, concentration
scaling and source order. Nothing is sorted, averaged, deduplicated, excluded
or mutated, and replicates remain independent observations.

Both searches also assume that the coarse grid brackets the basin containing the
optimum. The implemented coarse grids are **step 0.5 in `q`** (101 points over
[0, 50], `RATE_COARSE_STEPS = 100`) and **step 0.125 in λ** (9 points,
`LAMBDA_COARSE_STEPS = 8`); local refinement is golden-section inside the
bracketing cell, and the admissible rate range is bounded at `q = 50`. A
maximum narrower than a coarse cell can still be missed, and refinement only
searches inside the selected bracket. The grids are a numerical resolution
choice, not a statistical claim, and the reported point is always the best
evaluated one.

### 15.4 Conditional AICc

    AIC  = −2·lnL̂ + 2K
    AICc = AIC + 2K(K+1) / (n − K − 1)

The criterion is **unavailable**, with a structured reason, when:

| Condition | Reason |
| --- | --- |
| The analyst has not declared this error model | `ASSUMPTION_NOT_DECLARED` |
| That candidate has no successful fit | `FIT_UNAVAILABLE` |
| `lnL̂`, the deviance or φ̂ is not finite | `NON_FINITE_LIKELIHOOD` |
| φ̂ is not strictly positive | `ZERO_DISPERSION` |
| `n − K − 1 ≤ 0` | `INSUFFICIENT_OBSERVATIONS` |

The per-model gate matters: with five observations, M0 (`K = 3`) still has one
residual degree of freedom while M1 (`K = 4`) does not.

**Criteria from the two error models are never compared.** The common-variance
AICc (§13) and this one answer different questions under different assumptions.
Neither is substituted for the other, and the interface never ranks them
together.

### 15.5 What this model does not establish

- Declaring the variance function is an **assumption, not evidence**. Nothing
  here tests whether the variance really is proportional to the fitted
  concentration, nor whether errors are independent or Gaussian.
- A smaller AICc is relative support **within these two mean models under this
  variance function**. It is not proof of a mechanism and says nothing about a
  model outside the pair.
- Boundary estimates and nonlinear fitting weaken the regularity assumptions
  behind information criteria; boundary warnings are shown and the comparison
  is explicitly less reliable when they appear.
- The coarse search can miss a likelihood maximum narrower than a grid cell, and
  the M1 refinement is coordinate-based; it is a numerical search, not a proof
  that the global maximum was found.
- No model weight, probability, confidence interval, standard error, hypothesis
  test or winner classification is produced, and no threshold is applied.
- A residual-spread pattern (§14) never selects or activates this model. The
  declaration is always the analyst's.

### 15.6 Numerical behaviour

Rates are found by a bounded, deterministic search; the mixing fraction by the
coordinate refinement described above. The reported values are re-evaluated at
the final parameters. The cost is `O(n)` per objective evaluation and grows with
the number of trial rates; on this implementation a 500-row dataset completes
both fits in about 50 ms and a 25,000-row dataset (the storage limit) in about
one second. The computation happens only after the declaration.

### 15.7 Interface and boundaries

The section is its own card, placed after the common-variance comparison, and
appears only after a successful production fit. It contains:

- the declaration, starting unchecked, with the assumption statement and the
  caveat that declaring is not evidence;
- before declaration, an explicit statement that nothing has been computed;
- after declaration, a table with model identity, equation, `A`, `B`, `k`, the
  dispersion φ (in concentration units), the maximised log-likelihood, the total
  parameter count `K` and AICc;
- the `AICc(M1) − AICc(M0)` difference as arithmetic only;
- per-model reasons whenever a criterion is unavailable, fit warnings and the
  standing limitations of this comparison.

The declaration is local to the card and the card is keyed by dataset, so
switching datasets resets it. Nothing is persisted: no fit, dispersion,
likelihood, declaration or criterion is written to the dataset, its
measurements, IndexedDB, `.npex` or `.npsb`.

### 15.8 Phase 47 completion audit

Implemented across Phases 47A–47C:

- measured-dataset import, validation, ordered storage and `.npex` interchange;
- the one-compartment mono-exponential fit and its failure/boundary contract;
- observation-level residuals, RMSE, residual degrees of freedom and the
  preliminary data-support screen;
- the practical identifiability profile of the fit's own objective;
- the two-candidate comparison with a conditional common-variance AICc;
- residual-structure views and the conservative spread screen;
- maximum-likelihood fits for both candidates under the proportional-variance
  model, with its own conditional AICc.

Still deferred, and not claimed by this increment:

- a third candidate model (for example a bi-exponential decay);
- formal parameter uncertainty: confidence intervals, standard errors,
  covariance or profile-based intervals;
- general hypothesis tests or model weights;
- error models beyond the two implemented here (for example a weighted variant
  with an estimated variance function other than φ·μ);
- structural-identifiability analysis;
- any persistence or export of derived fits and criteria.

Phase 47 is therefore **not complete** after this increment.

## 16. Noncompartmental analysis (Phase 48)

A noncompartmental summary of the selected concentration–time dataset. It is
observational: it derives parameters from the measured rows without fitting a
compartmental model, and it is available on any dataset without a fit.

### 16.1 Definitions and formulas

| Parameter | Definition | Unit | Kind |
| --- | --- | --- | --- |
| Cmax | maximum observed concentration | concentration | observed |
| Tmax | earliest sampling time attaining Cmax | time | observed |
| AUC(last) | trapezoidal area over the observed interval | concentration·time | calculated |
| AUC(∞) | AUC(last) + C_last/λ_z | concentration·time | extrapolated |
| λ_z | −slope of ln(C) on time over the terminal phase | 1/time | calculated |
| t½ | ln(2)/λ_z | time | calculated |
| Extrapolated fraction | (AUC∞ − AUClast)/AUC∞ | fraction | calculated |

Linear trapezoid over `[t1, t2]`: `AUC = (C1 + C2)/2 · (t2 − t1)`.

Logarithmic trapezoid over a decreasing interval: `AUC = (C1 − C2)·(t2 − t1) /
ln(C1/C2)`, defined only when both concentrations are positive and unequal.
The **linear-up/log-down** method uses the linear trapezoid for an increasing
or equal interval, the logarithmic trapezoid for a decreasing interval, and
falls back to the linear trapezoid (reported as a note) when the logarithmic
form is undefined — the measurement is never dropped.

λ_z is a least-squares regression of `ln(concentration)` on time over the
selected terminal observations (the last `terminalPointCount` positive
concentrations; default 3, minimum 2). R² is the coefficient of determination
of that log-linear fit.

### 16.2 Units, ordering and provenance

All values use the dataset's declared time and concentration units; no unit
conversion is performed because every row already shares them. AUC is reported
in `concentration·time`. Input is read only and sorted on a copy: every result
carries the 1-based source rows it was derived from, so it is traceable to the
exact observations and analysis settings. Derived results are ephemeral and
never persisted.

### 16.3 Explicit behaviours

- **Unsorted input** is sorted by time for analysis; the stored order is never
  changed.
- **Duplicate sampling times** make AUC and terminal-phase metrics unavailable
  (`DUPLICATE_SAMPLING_TIMES`) and are reported with their times; observations
  are never averaged. Cmax and Tmax remain observed facts.
- **Zero or non-positive concentrations** are valid for Cmax and the linear
  trapezoid, excluded from logarithmic integration and the terminal regression
  (reported), and a trailing non-positive observation makes AUC(∞) unavailable
  (`TERMINAL_TAIL_NOT_POSITIVE`).
- **A dataset that does not start at zero** yields an area named for the
  interval it actually covers (`AUC(first→last)`), never `AUC0-last`; no
  concentration at time zero is invented or back-extrapolated.
- **Tied Cmax** reports the earliest time attaining the maximum, with a note.
- **Non-finite or negative measurements** fail the whole analysis
  (`INVALID_MEASUREMENT`); they are never discarded silently.
- **A non-negative terminal slope** makes λ_z and t½ unavailable
  (`NON_POSITIVE_TERMINAL_SLOPE`).
- **Insufficient positive observations** for the requested terminal count makes
  the terminal metrics unavailable (`INSUFFICIENT_TERMINAL_POINTS`).

### 16.4 Quality criteria (not validity proofs)

- Extrapolated fraction > 20% is flagged as a quality concern from regulatory
  NCA guidance. It is a criterion, not a guarantee that the estimate is valid.
- Terminal R² < 0.8 is flagged as a poorly determined terminal phase. It is a
  screening convention, not a proof that the phase is invalid.

### 16.5 Dose-dependent parameters — deferred

Clearance and volume of distribution require a dose, route and bioavailability
assumption. The experimental dataset model carries none of these, and none is
inferred. `CL/F` and `Vz/F` are therefore **not** computed in this phase; they
are recorded as a follow-up requiring an explicit dose/route contract.

### 16.6 Source and licensing

The formulas are standard NCA definitions implemented independently (see
`THIRD_PARTY_NOTICES.md`). PKNCA (AGPL-3.0) was studied as a reference but no
source was copied, because AGPL-3.0 cannot be combined with this repository's
PolyForm Noncommercial license without a license change. Intentional
differences from PKNCA are listed in the notices file.
