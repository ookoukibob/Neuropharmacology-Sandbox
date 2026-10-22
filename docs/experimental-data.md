# Experimental concentration–time datasets

**Status: Phases 47A and 47B plus the initial Phase 47C diagnostics slice — implemented.** This document is the
contract for measured-dataset import, validation, local storage, inspection and
`.npex` interchange, the optional one-compartment mono-exponential decay fit
(§10), and raw-residual/RMSE diagnostics (§11). Formal uncertainty estimation,
model comparison and AICc are not implemented.

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
- **Derived analysis never rewrites evidence.** Phase 47B fitting (§10) and
  the initial Phase 47C residual/RMSE diagnostics (§11) are temporary derived
  views; imports, stored observations, and `.npex` round trips are unchanged.
  RMSE is descriptive and has no universal pass/fail threshold. Formal
  identifiability tests, uncertainty estimates and model comparison need
  additional contracts and assumptions.

---

## 9. Verification map

| Layer | Representative files | Coverage |
| --- | --- | --- |
| Domain | `src/domain/experiments/experimental-dataset.test.ts`, `src/domain/experiments/mono-exponential-fit.test.ts`, `src/domain/experiments/mono-exponential-fit-diagnostics.test.ts` | dataset contract, bounded fit/failures, raw residuals/RMSE, row fidelity and limited data-support notes |
| Schemas | `src/data/schemas/experimentalDatasets.test.ts` | input/record/`.npex` shapes, limits, negative/non-finite rejection, units, duplicate measurement ids |
| CSV | `src/features/experiments/csvDataset.test.ts` | explicit mapping, RFC 4180 reuse, row-specific errors, qualifiers, duplicates/order, all-or-nothing |
| `.npex` | `src/data/npex/npex.test.ts` | envelope/version rules, strict shape, duplicate keys, depth/size, round trip, local identity absent |
| Repository | `src/data/repositories/dexieExperimentalDatasetRepository.test.ts` | CRUD, validation on read/write, corruption reporting, atomicity, optimistic tokens, immutable science, strict timestamp ordering |
| Database/recovery | `src/data/db/database.test.ts`, `experimentalDatasetRecovery.test.ts`, `archive.test.ts` | v5→v6 preservation, all-store snapshot/restore, legacy absent-store warnings/clearing, rollback |
| UI | `src/features/experiments/*.test.tsx`, `src/components/charts/experimentalDatasetAdapter.test.ts`, `src/components/charts/ExperimentalFitResidualChart.test.tsx` | import/preview/confirm, table, observed/fitted chart, residual plot, RMSE and screening states, rename/delete/export/error states |
| Browser | `e2e/experimentalDatasets.spec.ts`, `e2e/a11y.spec.ts` | real Chromium CSV→chart→`.npex`→re-import, persistence, recovery, fit overlay, residual plot/RMSE/data-support screen, narrow layout and axe scans |

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
available in §11. Parameter uncertainty, confidence intervals, R², formal
identifiability analysis and model comparison remain unimplemented.


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
  and failure behaviour are implemented and tested.

Tests use synthetic values only. The diagnostics function is pure and only
accepts a successful fit; a mismatch between the current measurements and the
fit's observation count produces a structured failure rather than displaying
stale or misaligned residuals.
