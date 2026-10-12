# CSV column contract (57 columns) — Phase 22

CSV export/import is a **lossy projection** of the drug library by design.
`.npsl` (and the `.npsb` recovery archive) remain the only lossless backup
formats. This document is the complete, per-column contract for the CSV
format: every actual header, its exported source, its import destination
(or the explicit reason it has none), its round-trip class, and the test
that pins its behavior.

**Drift detection.** Three independent artifacts must agree, and any
mismatch fails CI:

1. the implementation — `CSV_HEADERS`/`CSV_PARAMS` (`src/features/import-export/csv/csvExport.ts`, `params.ts`) and `CSV_DESTINATIONS` (`csvImport.ts`);
2. the test pin — the literal `EXPECTED_HEADERS` list and the destination
   bijection in `src/features/import-export/csv/csvColumnContract.test.ts`
   (25 tests, including a value matrix for all 57 columns);
3. this table.

A production header change cannot bypass the contract tests: the literal
header equality, the 57-row value matrix, and the 56-destination bijection
all fail independently.

## Round-trip classes

| Class | Meaning |
| --- | --- |
| **exact** | The value survives export → parse → mapping → NPSL validation verbatim (all cells are edge-trimmed on import; an empty cell becomes an *absent* optional, never an empty string). |
| **transformed** | An explicit, tested transformation applies (documented per column). |
| **policy-excluded** | Deliberately not importable; the export exists for spreadsheet visibility only. |
| **lossy** | Information is irrecoverably changed; the exact consequence is stated. |

## Derivation of the header

The header is fixed and derived from `CSV_PARAMS`: 10 drug-level columns,
6 target-level columns, 4 target parameters × 5 columns each, 1
PK-notes column, 4 PK parameters × 5 columns each — **57 columns in
total**, in exactly the order below. One row per target; a drug without
targets emits a single row with all target/parameter cells empty;
drug-level and PK columns repeat on every row of the same drug and are
tied together by `drug_id`.

## Drug-level columns (1–10)

| # | Header | Exported from | CSV representation | Import destination | Class | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `drug_id` | `drug.id` | guarded text | `drug.id` | exact | Explicit grouping key: rows sharing a drug id merge into one record; repeated rows must repeat identical drug-level values (a mismatch blocks the whole import). Empty id → generated on import. |
| 2 | `origin` | `drug.origin` | guarded text (enum: `built-in-demo`/`user`/`imported`) | *none* | policy-excluded | Storage bookkeeping, never scientific provenance. No destination exists; imports always stamp `origin: 'imported'`. The preview lists it as the only unmapped column. |
| 3 | `name` | `drug.identifiers.name` | guarded text | `drug.name` | exact | The one required destination. |
| 4 | `synonyms` | `drug.identifiers.synonyms` | `'; '`-joined guarded text | `drug.synonyms` | transformed | Export joins with `'; '`; import splits on `';'` and trims. A synonym containing `';'` cannot round-trip (split ambiguity). |
| 5 | `description` | `drug.identifiers.description` | guarded text | `drug.description` | exact | Empty cell → field absent. Interior newlines/quotes/commas survive (RFC 4180 quoting). |
| 6 | `cas_number` | `drug.identifiers.casNumber` | guarded text | `drug.casNumber` | exact | Empty cell → absent. |
| 7 | `tags` | `drug.tags` | `'; '`-joined guarded text | `drug.tags` | transformed | Same list semantics as `synonyms`. |
| 8 | `notes` | `drug.notes` | guarded text | `drug.notes` | exact | Empty cell → absent. |
| 9 | `created_at` | `drug.createdAt` | guarded text (ISO 8601) | `drug.createdAt` | exact | Mapped verbatim if provided; empty → absent; a non-ISO value is blocked by the shared NPSL schema at preview. |
| 10 | `updated_at` | `drug.updatedAt` | guarded text (ISO 8601) | `drug.updatedAt` | exact | Same as `created_at`. On re-import, the *library's* `updatedAt` is stamped to import time regardless (see global policies). |

## Target-level columns (11–16)

| # | Header | Exported from | CSV representation | Import destination | Class | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 11 | `target_id` | `target.id` | guarded text | `target.id` | exact | Empty → generated at import. Duplicate ids within one drug block the whole import, naming both rows. |
| 12 | `target_name` | `target.name` | guarded text | `target.name` | exact | Required whenever any target field is present on a row. |
| 13 | `target_gene` | `target.gene` | guarded text | `target.gene` | exact | Empty → absent. |
| 14 | `target_action` | `target.action` | guarded text (enum) | `target.action` | exact | An unknown action is a blocking row error (`"…" is not one of …`). |
| 15 | `target_species` | `target.species` | guarded text | `target.species` | exact | Empty → absent. |
| 16 | `target_notes` | `target.notes` | guarded text | `target.notes` | exact | Empty → absent. |

## Target parameter columns (17–36)

Each of the four target parameters — `kd`, `ki`, `ec50`, `ic50` — owns
five columns in the fixed order *value, unit, provenance type,
provenance source, provenance JSON*. Kd, Ki, EC50 and IC50 are strictly
separate destinations; no substitution or inference is ever applied.

| # | Header | Import destination | Class | Notes |
| --- | --- | --- | --- | --- |
| 17 | `kd` | `kd.value` | exact¹ | Number cell — never formula-guarded, never text-sanitized (negative values and scientific notation like `1e-9` stay byte-exact). |
| 18 | `kd_unit` | `kd.unit` | exact | Stored **verbatim** — no conversion, no default. Unit source policy: the value needs its own unit column or a visibly declared fixed unit (molar/mass concentration catalog for Kd/Ki/EC50/IC50). |
| 19 | `kd_provenance_type` | `kd.prov.type` | exact | One of `literature`, `user`, `calculated`, `derived`, `unknown`; anything else blocks the import. Empty → stamped `{type:'user', recordedAt:<import time>}` (provenance is never invented as literature). |
| 20 | `kd_provenance_source` | `kd.prov.source` | exact | Only meaningful for `literature` (required there; falls back to the JSON cell's `source` key). A non-empty source on a non-literature type blocks the import. |
| 21 | `kd_provenance_json` | `kd.prov.json` | exact | The remaining provenance fields as a JSON object string (`citation`, `doi`, `url`, `recordedAt`, `model`, `method`, `from`, `notes`, unknown keys…). Rejoined into the provenance object on import; an empty cell means no remainder. Malformed JSON blocks the import. |
| 22–26 | `ki`, `ki_unit`, `ki_provenance_type`, `ki_provenance_source`, `ki_provenance_json` | `ki.*` | same as Kd | Same five-column contract. |
| 27–31 | `ec50`, `ec50_unit`, `ec50_provenance_type`, `ec50_provenance_source`, `ec50_provenance_json` | `ec50.*` | same as Kd | Same five-column contract. |
| 32–36 | `ic50`, `ic50_unit`, `ic50_provenance_type`, `ic50_provenance_source`, `ic50_provenance_json` | `ic50.*` | same as Kd | Same five-column contract. |

¹ Exception within "exact": IEEE `-0` serializes as `'0'` (`String(-0)`)
— CSV cannot carry the sign of negative zero. The `-0` numeric sidecar
exists only in the NPSL/recovery formats (see `recovery-backup.md` §8).

## Pharmacokinetic columns (37–57)

| # | Header | Exported from | Import destination | Class | Notes |
| --- | --- | --- | --- | --- | --- |
| 37 | `pk_notes` | `drug.pharmacokinetics.notes` | `pk.notes` | exact | Drug-level; repeats on every row of the drug. Empty → absent. |
| 38–42 | `half_life`, `half_life_unit`, `half_life_provenance_type`, `half_life_provenance_source`, `half_life_provenance_json` | `pharmacokinetics.halfLife` | `halfLife.*` | exact¹ | Same five-column contract; unit from the time dimension catalog when a fixed unit is declared. |
| 43–47 | `clearance`, `clearance_unit`, `clearance_provenance_type`, `clearance_provenance_source`, `clearance_provenance_json` | `pharmacokinetics.clearance` | `clearance.*` | exact¹ | Unit is free text — the catalog enumerates no clearance dimension. |
| 48–52 | `volume_of_distribution`, `volume_of_distribution_unit`, `volume_of_distribution_provenance_type`, `volume_of_distribution_provenance_source`, `volume_of_distribution_provenance_json` | `pharmacokinetics.volumeOfDistribution` | `volumeOfDistribution.*` | exact¹ | Unit is free text (no catalog dimension). |
| 53–57 | `bioavailability`, `bioavailability_unit`, `bioavailability_provenance_type`, `bioavailability_provenance_source`, `bioavailability_provenance_json` | `pharmacokinetics.bioavailability` | `bioavailability.*` | exact¹ | Unit from the dimensionless catalog when a fixed unit is declared. |

## Global transformation and loss policy

Every item below is executable coverage in
`csvColumnContract.test.ts` (or the existing CSV suites where noted).

| Policy | Consequence on re-import |
| --- | --- |
| **Formula-injection guard** | Every *text* cell beginning (after leading whitespace/control characters) with `=`, `+`, `-` or `@` gains a leading apostrophe on export. The apostrophe is **kept verbatim** on re-import — deliberately lossy; stripping it would corrupt legitimate data. |
| **Numeric cells are never guarded** | Value columns stay plain numbers (`-2.5`, `1e-9` byte-exact); text sanitization is never applied to them. |
| **Edge trim** | Every imported cell is trimmed of leading/trailing whitespace; interior whitespace, newlines, quotes and commas survive. |
| **Empty vs missing** | An empty cell means *absent* — optional fields are omitted from the record, never stored as empty strings. |
| **Provenance stamping** | A parameter value with no mapped provenance columns is stamped `{type:'user', recordedAt:<import time>}` — user data is never silently upgraded. |
| **`origin` re-stamp** | Imports always set `origin: 'imported'`; the exported column is informational only. |
| **Library bookkeeping** | A CSV import keeps the current library's id/name, sets `dataStatus: 'user'` and `updatedAt: <import time>`; drug-level `created_at`/`updated_at` are preserved only when explicitly mapped. |
| **Unknown fields** | Forward-compatible unknown fields are never exported (only these 57 columns exist) and therefore do not survive CSV. `.npsl`/`.npsb` preserve them. |
| **`-0` sign** | Negative zero exports as `'0'`; the sign is not representable in CSV. |
| **Grouping** | Rows group by explicit `drug_id`, never by name equality; conflicting repeated drug-level values, duplicate target ids inside one drug, unknown actions, invalid provenance types or malformed provenance JSON each block the **whole** import (all-or-nothing). |
| **No unit conversion** | Units are stored verbatim in both directions. |

## Import destination catalog

`CSV_DESTINATIONS` exposes exactly **56** destinations — every header
except `origin` — and each maps one-to-one onto a column: 9 drug
destinations (`drug.id`, `drug.name`, `drug.synonyms`,
`drug.description`, `drug.casNumber`, `drug.tags`, `drug.notes`,
`drug.createdAt`, `drug.updatedAt`), 6 target destinations
(`target.id`…`target.notes`), `pk.notes`, and 8 parameters × 5
(`.value`, `.unit`, `.prov.type`, `.prov.source`, `.prov.json`). The
bijection is asserted in `csvColumnContract.test.ts` ("offers 56 unique
destinations…"). Mapping stays fully explicit: nothing is inferred from
column names, and unmapped columns are listed in the preview.

## Evidence

- `src/features/import-export/csv/csvColumnContract.test.ts` — 25 tests: pinned 57-header equality, 57-cell row widths, the all-57-column value matrix (marker library with distinguishable values in every field, all five provenance variants, negative/scientific numbers, hostile text), one-row-per-target and drug-level repetition, targetless-drug row, full export → `parseCsv` → mapping → NPSL-validation round trip, real-repository commit and read-back (including `revision` bookkeeping), and every policy boundary above.
- `csvExport.test.ts`, `csvImport.test.ts`, `parseCsv.test.ts`, `writeCsv.test.ts` — pre-existing schema, grouping, provenance, parser and writer coverage retained unchanged.
- UI path: `ImportExportView.test.tsx` ("maps columns explicitly, resolves Kd/Ki by user choice, previews, imports").

The visible CSV-loss warning in the export panel
(`ExportPanel.tsx` — "CSV is not a substitute for `.npsl`") remains the
user-facing statement of these limits and is not weakened by this contract.
