# Recovery backup format (`.npsb`)

**Status: Phase 8A — contract designed. Nothing in this document is
implemented.** Export and restore ship in Phase 8B; until then the only
export formats are `.npsl`/`.json`/`.csv` (interchange — they exclude
quarantined rows, see §2). No code, schema, migration, dependency or CI
change accompanies this specification.

This document is the implementation-ready contract for a lossless-within-
a-defined-boundary recovery backup of the local IndexedDB library. Every
data-loss behavior below is decided, not left to the implementer. Terms
like "lossless" are only used with the fidelity contract of §6 attached.

---

## 1. Purpose and non-goals

**Purpose.** Take a complete, faithful snapshot of the application's
IndexedDB database (`neuropharmacology-sandbox`, both object stores) —
including raw rows that the current build cannot validate (quarantine) and
rows with unknown/future fields — as a single local file, and restore such
a file verbatim, atomically, under explicit user acknowledgement.

**In scope (Phase 8B):** `.npsb` export, `.npsb` preview/restore UI,
fidelity scanning, numeric sidecar, reclassification reporting.

**Non-goals.**

- Not an interchange format. Sharing validated libraries stays `.npsl`
  ([npsl-format.md](npsl-format.md)); ordinary import stays strict (§2).
- Not merge/sync/backup-scheduling: v1 restore is full replacement only.
- No backend, no cloud upload, no telemetry, no remote storage of any kind.
- No automatic repair, deletion, backfill or "cleanup" of restored rows.
- No cryptographic integrity or authenticity guarantee in v1 (§13).
- No change to NPSL versions, `drugSchema`, scientific values, units or
  provenance semantics.
- Not a schema migration tool: Dexie version upgrades keep owning that
  ([database.ts](../src/data/db/database.ts), ADR-14).
- Post-restore *edits* follow existing application semantics; this contract
  covers fidelity only at the export and restore boundaries.

---

## 2. Why it is separate from NPSL

### 2.1 Current storage behavior (verified against the code)

1. **Stores.** `SandboxDatabase` declares versions 1 and 2. v1: `drugs`
   keyed by `id`, `meta` keyed by `id`. v2 (current): `drugs` gains the
   `origin` and `updatedAt` indexes; `meta` unchanged. The v2 upgrade hook
   backfills only `persistenceVersion` and missing timestamps and "never
   creates, rewrites or deletes scientific fields or unknown (future)
   fields" (`database.ts`, `version(2).upgrade`).
2. **Quarantine is derived, not stored.** `getAllDrugs()` reads raw rows
   (`db.drugs.toArray()`), runs `fromRecord()` (`records.ts` — a
   `drugSchema.safeParse`), and on failure pushes
   `{ id, errors, record }` into `LibraryLoadResult.quarantine`
   (`dexieDrugRepository.ts`, `getAllDrugs`; `repository.ts`,
   `QuarantinedRecord`). There is no quarantine flag, marker or store;
   ADR-15 holds that hydration reports instead of repairing.
3. **`recordKey()` is display-only.** For rows whose `id` is not a
   non-empty string it returns the literal `"(missing id)"`
   (`dexieDrugRepository.ts`, `recordKey`), so two different rows can
   display the same identifier. A backup must capture the real
   IndexedDB primary key (§5), never this display string.
4. **`exportLibrary()` is not a storage snapshot.** It returns
   `{ metadata, drugs }` with readable drugs only; quarantined rows stay
   stored but are excluded (`dexieDrugRepository.ts`, `exportLibrary`).
   The UI announces the excluded count (`ExportPanel.tsx`,
   `data-testid="export-quarantine-warning"`), and `testing.md` §5 already
   scopes the "lossless" claim of `.npsl` accordingly.
5. **`getLibraryMetadata()` reads only the first `meta` row**
   (`db.meta.toArray()[0]`) and creates the first-run default if absent
   (`dexieDrugRepository.ts`, `getLibraryMetadata`). Additional metadata rows are possible in storage
   (tests write a legacy row directly) and are silently ignored by the app.
   The recovery format must therefore capture and restore **all** meta
   rows explicitly (§4, §8).
6. **Ordinary import is strict and transactional.** `importLibrary()`
   parses (`parseNpsl`: JSON + envelope string versions +
   `checkNpslVersions`) outside the transaction, then inside one Dexie
   `rw` transaction runs `validateNpslFile` (schema, semantic checks,
   duplicate ids) before any write; failures leave the library untouched
   (tested in `dexieDrugRepository.test.ts`, "importLibrary"). None of
   this changes.
7. **`replaceLibrary()` cannot restore invalid rows.** It reconstructs
   domain records through `toStoredRecord()` + `assertWritable()`
   (`drugSchema` re-validation) before writing
   (`dexieDrugRepository.ts`, `replaceLibrary`, `assertWritable`). A raw
   row that fails `drugSchema` can never pass through it — by design.
8. **The store already distinguishes commit from refresh failure.**
   `LibraryImportOutcome` has `ok | invalid | failed |
   committed-refresh-failed` (`features/drug-library/store.ts`); the UI
   shows a committed-but-refresh-failed report with a session-refresh
   retry (`ImportPanel.tsx`, `retry-refresh`). Recovery restore must
   provide the equivalent four outcomes (§8.5).
9. **Write-path evidence for fidelity (§6).** Rows enter storage only
   via: NPSL/CSV import (`JSON.parse` output), form/CSV number parsing
   (`Number(...)` in `DrugForm.tsx` and `csvImport.ts`), validated CRUD
   (`toRecord()` omits `undefined`), and the v2 upgrade hook (strings).
   Contract fields reject non-finite numbers (`z.number().finite()` in
   `npsl.ts`); unknown fields are carried verbatim by the loose schema.

### 2.2 Why NPSL cannot absorb this

`drugs[]` in NPSL means "records that passed `drugSchema`". Making NPSL
carry raw invalid rows would require either weakening `drugSchema`/import
validation (forbidden by ADR-8/ADR-14 and by this mission) or a
bypass marker that lets import *choose* strictness per file — which turns
the ordinary import path into a validation escape hatch. `replaceLibrary()`
and `importLibrary()` would also need raw-write modes (§2.1/7).

**Decision: a separate archive.** Structural separation is verifiable in
both directions:

- A `.npsb` archive fed to ordinary NPSL import fails in `parseNpsl()`:
  it has no string `formatVersion` → `SCHEMA` error "envelope must
  declare string formatVersion…", zero writes (existing behavior,
  `importPipeline.ts`, `parseNpsl`).
- An `.npsl`/`.json` file fed to recovery restore fails the format check:
  `formatId` is missing/not `"npsb"` → `ARCHIVE_NOT_NPSB` with guidance
  to use Import (§10).

Neither path needs to know about the other; tests pin both directions
(§15).

---

## 3. Format identity, extension and versioning

| Property | Value | Rationale |
| --- | --- | --- |
| File extension | `.npsb` | Verified free: no file in the repository uses it and no code references it. Name: **N**euro**p**harmacology **S**andbox **B**ackup. |
| MIME type | `application/json;charset=utf-8` | The archive is text JSON; identical to the existing `.npsl`/`.json` download type (`ExportPanel.tsx`). |
| Format discriminator | `"formatId": "npsb"` (exact literal) | Authoritative detection; the extension is a hint only. |
| Archive version | `"backupVersion"`, semver string | **Independent** of NPSL `formatVersion`/`schemaVersion`; the two version spaces never read or write each other's constants. |
| Reader constant (proposed, 8B) | `BACKUP_VERSION = '1.0.0'` in a new recovery module | Must **not** be added to `npsl.ts` or reuse `checkNpslVersions()` (it is hardwired to the NPSL constants); a sibling helper with the same semantics is written for backups. |

**Compatibility rule (same semantics as NPSL §1, separate implementation):**
an archive is restorable when `backupVersion` and the reader's version have
equal major and the file's minor ≤ the reader's minor. Otherwise restore is
refused with an explicit message (`ARCHIVE_VERSION`) — newer minor:
"…newer than supported X; update the application"; major mismatch: not
supported. Malformed semver is also `ARCHIVE_VERSION`. Never partial
application.

**Envelope strictness.** The v1 top-level key set is *exactly* the seven
keys of §4. Any missing key or unknown extra key is rejected
(`ARCHIVE_ENVELOPE_SHAPE`). The version rule above makes this consistent
with forward compatibility: new fields arrive with a minor bump, which
older readers already refuse.

---

## 4. Envelope and row-entry schema

### 4.1 Top level (exact key set, all required)

| Field | Type | Validation | Meaning |
| --- | --- | --- | --- |
| `formatId` | string | must equal `"npsb"` | Discriminator (§3) |
| `backupVersion` | string | semver + §3 rule | Archive version |
| `exportedAt` | string | ISO 8601 date-time | **Informational only** — never written into storage on restore |
| `storage` | object | exactly `{databaseVersion, persistenceVersion}`, both non-negative integers | **Informational only** — diagnostics/preview warnings (§8.3); never used to skip validation or transform rows |
| `counts` | object | exactly `{drugRows, readableAtExport, quarantinedAtExport, metaRows}`, non-negative integers; invariants below | Export-time facts of the snapshot |
| `drugs` | array of entries | ≤ `MAX_DRUG_ROWS` (§12) | Every `drugs` store row, verbatim |
| `meta` | array of entries | ≤ `MAX_META_ROWS` (§12) | Every `meta` store row, verbatim |

**Counts invariants (mandatory counts; verified at restore, rejection on
any violation — `ARCHIVE_COUNT_MISMATCH`):**

- `drugRows === drugs.length`
- `metaRows === meta.length`
- `readableAtExport + quarantinedAtExport === drugRows`
- All four values are non-negative safe integers.

Counts are *structural* assertions only. `readableAtExport`/
`quarantinedAtExport` record what the **exporting build** classified; they
are deliberately **not** re-verified against the receiving build's
classification (§9) — a difference is expected, reported, never rejected.

### 4.2 Row entry (exact key set)

| Field | Type | Required | Validation |
| --- | --- | --- | --- |
| `key` | string | yes | The captured IndexedDB primary key (§5). Any non-string → `ARCHIVE_KEY_TYPE` |
| `value` | plain object | yes | The raw stored row, JSON domain (§6). Must have own `id` strictly equal to `key` → else `ARCHIVE_KEY_MISMATCH` |
| `specialNumbers` | array | no | Numeric sidecar (§6.3); shape/paths validated with `ARCHIVE_ANNOTATION_*` |

Unknown keys inside an entry → `ARCHIVE_ENTRY_SHAPE`.

Duplicate `key` values **within** `drugs` (or within `meta`) →
`ARCHIVE_DUPLICATE_KEY`, reported with both entry indices, deterministic
(first duplicate in array order). The same key appearing in `drugs` and in
`meta` is fine — different stores. Rejection is mandatory *before* the
write transaction because IndexedDB `put` on an existing key **silently
replaces** it: duplicates would otherwise destroy rows without an error.

### 4.3 Illustrative archive

All identifiers, names and values below are **synthetic test fixtures** —
fictional placeholders, not pharmacological information.

```jsonc
{
  "formatId": "npsb",
  "backupVersion": "1.0.0",
  "exportedAt": "2026-10-09T00:00:00.000Z",
  "storage": { "databaseVersion": 2, "persistenceVersion": 2 },
  "counts": {
    "drugRows": 2,
    "readableAtExport": 1,
    "quarantinedAtExport": 1,
    "metaRows": 1
  },
  "drugs": [
    {
      "key": "synthetic-valid-id",
      "value": {
        "id": "synthetic-valid-id",
        "origin": "user",
        "identifiers": { "name": "Synthetic recovery fixture" }
      }
    },
    {
      "key": "synthetic-invalid-id",
      "value": {
        "id": "synthetic-invalid-id",
        "origin": "INVALID-SYNTHETIC-ORIGIN",
        "futureField": { "keep": "synthetic unknown data" }
      }
    }
  ],
  "meta": [
    {
      "key": "synthetic-library-id",
      "value": {
        "id": "synthetic-library-id",
        "name": "Synthetic recovery fixture",
        "createdAt": "2026-01-01T00:00:00.000Z",
        "updatedAt": "2026-01-01T00:00:00.000Z"
      }
    }
  ]
}
```

The first drug passes `drugSchema` (`tags`/`targets`/`pharmacokinetics`
have defaults); the second is quarantined by its `origin` yet must survive
the round trip byte-for-byte, unknown `futureField` included. Example with
a sidecar (see §6.3):

```jsonc
{
  "key": "synthetic-invalid-id",
  "value": { "id": "synthetic-invalid-id", "extensionValue": null },
  "specialNumbers": [{ "path": "/extensionValue", "kind": "Infinity" }]
}
```

---

## 5. Storage keys: capture, representation, validation

**Capture (export).** Rows are read with a cursor so the *actual*
IndexedDB primary key is recorded — `cursor.key` plus `cursor.value` — not
inferred from `recordKey()` or from any display logic. Evidence for doing
so: `recordKey()` collapses empty/non-string ids to `"(missing id)"`
(§2.1/3), while `drugSchema` requires `id: z.string().min(1)`.

**Identity invariant.** The stores use an in-line key path (`drugs` and
`meta` both declare `id`), so IndexedDB derives every primary key from the
row's own `id` property: at read time `cursor.key ≡ value.id` always
holds. The archive stores both anyway; restore **requires** exact
equality (`ARCHIVE_KEY_MISMATCH` otherwise). This guards hand-edited
archives, where key and value can be made to disagree — an ambiguous row
is rejected, never guessed.

**Support policy: string keys only.**

- Every key this application can produce is a non-empty string
  (`newId()` UUIDs, NPSL ids, `DEFAULT_LIBRARY_ID = "local-library"`), and
  every write path validates `id` as `z.string().min(1)`
  (`assertWritable`, `validateNpslFile`). Empty-string keys are
  representable and accepted by the format (they are valid IndexedDB keys)
  even though no application path writes one.
- IndexedDB additionally permits number, `Date`, binary and array keys.
  A non-string key in the `drugs`/`meta` stores can therefore only arise
  from writes that bypassed the application (devtools, another tool).
- **Export:** the first non-string `cursor.key` fails the whole export
  with `BACKUP_UNSUPPORTED_KEY` — store name, entry index, key type and a
  description of the key. **No partial file is ever produced.** A
  misrepresentable row is not a reason to quietly drop it, and inventing
  encodings for `Date`/binary/array keys would extend the format for
  states this application cannot legitimately produce.
- **Restore:** `ARCHIVE_KEY_TYPE` for any non-string `key`.
- `key === value.id` (both strings) is checked for every entry before any
  write (§8.2).

**Restore mechanics.** With an in-line key path, Dexie/IndexedDB only
accepts `put(value)` — the key is re-derived from `value.id`. Because
`value.id === key` was validated for every entry, the derived key is
exactly the archived key; `put(value, explicitKey)` is not used (it throws
on key-path stores).

---

## 6. Fidelity contract

### 6.1 Definition

An export→file→parse→restore cycle is **fidelity-exact for the supported
stored-value domain** when every restored row satisfies deep equality `E`
with the exported row, defined leaf-wise as:

- **Numbers:** `Object.is` — distinguishes `0` from `-0`, and makes `NaN`
  equal `NaN`; finite doubles round-trip exactly because
  `JSON.parse(JSON.stringify(x)) === x` for every finite double (ECMAScript
  shortest round-trip `Number::toString`), and the sidecar (§6.3) restores
  `-0`/`NaN`/`±Infinity`.
- **Strings, booleans, `null`:** exact.
- **Arrays:** same length, same dense positions, elements compared under
  `E`. Holes are not supported (§6.2).
- **Objects:** same set of own enumerable keys (order-independent), values
  compared under `E`.
- **Not contractual:** object prototype identity (structured clone already
  normalizes to `Object.prototype` — verified) and own-key insertion
  order (preserved in practice; not promised, not asserted).

Export **verifies** this cycle before any download is offered (§6.4).

### 6.2 Supported domain and unsupported values

Supported (domain **D**): `null`, booleans, strings, finite numbers
(including `-0` via sidecar), `NaN`/`±Infinity` (via sidecar), plain
objects with own enumerable string-keyed properties, dense arrays.

**Reachability evidence.** Application write paths only produce values
that `JSON.parse` produces (NPSL/CSV import), plus `Number(...)` results
(form/CSV), with `undefined` omitted by `toRecord()` and non-finite values
blocked in contract fields by `z.number().finite()` — except `-0`
(`Number("-0")`, JSON literal `-0`) and `±Infinity` inside *unknown*
fields (`JSON.parse("1e400")`, kept verbatim by the loose schema). These
four numeric shapes are therefore **supported** (sidecar), not rejected.
Values outside **D** (`Date`, `RegExp`, `Map`, `Set`, `ArrayBuffer`,
typed arrays, `Blob`, `Error` objects, `BigInt`, symbols, functions,
`undefined` properties, sparse holes, cycles, non-plain prototypes) cannot
be produced by any current write path — the database could only contain
them through external modification or a future build violating the record
contract.

**Policy:** export **fails with a structured error** — never coerces,
never omits, never relabels an incomplete file as a backup:

```
BACKUP_UNSUPPORTED_VALUE { store: 'drugs'|'meta', key, path, type }
BACKUP_UNSUPPORTED_KEY   { store, index, keyType, keyDescription }
```

`path` is the RFC 6901 pointer (root `""`) of the offending property;
`type` is the runtime type (`"date"`, `"bigint"`, `"sparse-array"`,
`"cycle"`, `"undefined"`, `"map"`, …). All offending values are
accumulated and reported together. No file is offered until the list is
empty. There is **no fallback to `.npsl`/`.csv`** on failure — those are
not storage backups (§1).

**Why boundary + explicit failure instead of a general serializer:** a
typed encoding for `Date`/`Map`/binary/… would be a general-purpose
object serializer whose escaping and tag-collision correctness becomes the
new data-loss risk, to serve states the storage contract never produces.
If a future build legitimately widens the record contract, that build must
bump `backupVersion` and extend **D** in the same change (§13).

### 6.3 Numeric sidecar (adopted)

JSON cannot carry `NaN`/`±Infinity` (stringified to `null`) or `-0`
(stringified to `0`). For these four kinds an entry-level sidecar
reconstructs the exact value:

| `kind` | JSON placeholder emitted at the path | Restore precondition | Value written |
| --- | --- | --- | --- |
| `"-0"` | `0` (i.e. placeholder satisfies `v === 0`) | placeholder is a number equal to `0` (accepts a literal `-0` edit — idempotent) | `-0` |
| `"NaN"` | `null` | placeholder is `null` | `NaN` |
| `"Infinity"` | `null` | placeholder is `null` | `Infinity` |
| `"-Infinity"` | `null` | placeholder is `null` | `-Infinity` |

Rules (each violation → the stated error, all before any write):

- **Path syntax:** RFC 6901 JSON Pointer relative to the entry's `value`
  (root of the record). Must start with `/`; escape decoding follows the
  RFC order — `~1` → `/` first, then `~0` → `~`, so `~01` resolves to the
  literal `~1`. A trailing `~` or unknown escape (`~2`), a non-pointer
  string, or the empty root pointer are `ARCHIVE_ANNOTATION_PATH`.
  Root is an object, so every valid pointer
  targets a descendant property — `""` is rejected. Keys containing `/`
  or `~` are therefore addressable (`/future~1field`).
- **Resolution is own-property-only:** every segment must exist as an
  *own* property of the current node (`hasOwnProperty`), else
  `ARCHIVE_ANNOTATION_PATH`. Segments never traverse the prototype chain,
  so `__proto__`, `constructor`, `prototype` are plain data names when
  present as own keys and unreachable when not — no prototype pollution
  and no accidental navigation into `Object.prototype`.
- **Traversal nodes** must be plain objects or arrays; array segments
  must be canonical decimal indices within bounds.
- **Duplicate paths within one entry** →
  `ARCHIVE_ANNOTATION_DUPLICATE`. Duplicate *key names* in the JSON text
  are rejected at the document level (§8.2/2).
- **Placeholder matching precedes reconstruction.** The sidecar never
  invents a value at an empty spot: the path must resolve (no
  auto-vivification), then the placeholder check above must pass →
  `ARCHIVE_ANNOTATION_PLACEHOLDER` otherwise.
- **`kind`** must be one of the four literals → else
  `ARCHIVE_ANNOTATION_SHAPE` (also for extra/missing keys in an
  annotation object).
- **Unannotated special numbers are rejected:** after `JSON.parse`, a
  value that is `-0`/`NaN`/`±Infinity` without a matching annotation →
  `ARCHIVE_VALUE_DOMAIN`. This covers hand edits and JSON overflow
  literals (`1e400` parses to `Infinity`, `-0` parses to `-0`); `NaN`
  has no JSON literal and fails at parse (§10 `ARCHIVE_PARSE`). The
  exporter's guarantee "every special leaf has an annotation" plus this
  check makes special numbers appear only as designated placeholders at
  annotated paths — deterministic, single representation.

**Where the sidecar does *not* apply:** object *keys* are strings;
`-0`/`NaN` as object keys are impossible (keys are strings).

### 6.4 Serialization and verification before download (export)

1. Build the archive object from the snapshot (§7).
2. Serialize: `JSON.stringify(archive, null, 2)` (pretty, matching the
   `.npsl` serializer's style) as UTF-8 text.
3. **Verify:** `JSON.parse` the serialized text, re-apply every sidecar
   through the *same* materialization routine restore uses, then deep-compare
   each entry against the in-memory source row under `E` (§6.1) — same
   array lengths/positions, same own-key sets, `Object.is` leaves. Counts
   are re-checked against the arrays (§4.1).
4. Only if every row verifies is the text handed to `downloadTextFile`
   (§7.5). Any mismatch → `BACKUP_VERIFY_FAILED` (internal consistency
   failure), **no file**. This catches serializer or scanner defects at
   runtime instead of shipping them.

The archive contains no executable constructs: restore never evaluates,
deserializes classes or revives functions — data only.

---

## 7. Backup export algorithm (proposed API: `exportRecoveryArchive()`)

Read-only; never mutates storage; never falls back to another format.

1. **Snapshot read.** Open **one** Dexie `readonly` transaction over
   `drugs` and `meta`, and complete *both* bulk reads inside it, capturing
   `(cursor.key, cursor.value)` per row via cursors. IndexedDB read-only
   transactions observe the database as of transaction start and cannot
   see interleaved read-write effects; the repository already performs
   multi-`await` work inside a single Dexie transaction
   (`importLibrary`, `replaceLibrary` — atomicity asserted by
   `dexieDrugRepository.test.ts`). All classification, scanning and
   serialization run *after* both reads complete and the transaction has
   ended, on the in-memory copies (IDB transactions deactivate on event
   loop turns without pending requests — no CPU-heavy work inside).
   - **Concurrent mutation during export** therefore cannot mix states:
     the archive is the snapshot at transaction start; counts are computed
     from that same snapshot, so counts and entries always agree. A row
     added or removed afterwards is simply not part of this archive —
     take another export. A read failure inside the transaction →
     `BACKUP_READ_FAILED`, no file.
   - **Fallback (environment cannot hold one transaction):** read rows,
     then re-read a cheap signature (store counts) and compare; one retry
     if it changed; a second change → `BACKUP_READ_FAILED`. Never emit a
     file assembled from mixed reads. (This transaction behavior is
     specified, not yet exercised on real browsers in 8A; Phase 8B must
     prove it with the repository test and an E2E case — §15.)
2. **Classify** each `drugs` row with the current build's `fromRecord()`
   (identical to `getAllDrugs()`) → `readableAtExport`,
   `quarantinedAtExport`. Classification is informational (§9) and never
   filters which rows are exported — **every** row is exported.
   `meta` rows are not classified (no quarantine concept exists for meta);
   capture them verbatim.
3. **Fidelity scan** every value (§6.2), accumulating structured errors;
   capture keys per §5. Any error → fail, no file.
4. **Assemble + verify** per §6.4, with counts from the same snapshot.
5. **Download** only on success:
   ``downloadTextFile(`${safeFileName(metadata.name)}.npsb`, text,
   'application/json;charset=utf-8')`` (existing helpers,
   `fileIo.ts`). The success report states: total rows exported, how many
   were readable/quarantined at export, and that the file is **not**
   authenticated or checksummed (§13).

---

## 8. Restore: validation, preview, atomicity, outcomes

Proposed APIs (names indicative, Phase 8B final):
`previewRecoveryArchive(text)` — validation + read-only classification;
`restoreRecoveryArchive(text)` — re-validate, then one transaction;
store action `restoreArchive(text)` — mirrors `importLibrary`'s two-phase
commit/refresh (`store.ts`).

### 8.1 Full replacement only

v1 restore is **full snapshot replacement** of `drugs` and `meta`: both
stores are cleared and rewritten from the archive. Merge is deferred: for
raw rows that may be schema-invalid, "merge" has no defined update or
delete semantics per id (which invalid row wins? what does updating an
unreadable row mean?), and half-defined merge is exactly how rows get
silently lost. A future merge mode requires its own ADR.

Scope: every `drugs` row, **every** `meta` row (all rows, not only the
first — §2.1/5). Envelope fields (`formatId`, `counts`, `storage`,
`exportedAt`) are archive metadata and are **not** written into storage.

### 8.2 Validation before any write (all of it, in order)

Checked on the raw text, read-only, before the write transaction opens.
Any violation → outcome `rejected`, zero writes:

1. **Size:** file byte length ≤ 64 MiB (§12) → `ARCHIVE_TOO_LARGE`
   (checked on the `File` before reading where available, and on the
   decoded text).
2. **Duplicate JSON keys:** a string-aware textual scan over the whole
   document (tracking string/escape state so `"drugs":` inside a string
   value does not count) → duplicate object key anywhere →
   `ARCHIVE_DUPLICATE_JSON_KEY` with the key name and line/column.
   *Mechanism constraint:* `JSON.parse` alone cannot detect this (it
   silently keeps the last occurrence — verified) and a reviver sees only
   post-collapse objects; Phase 8B must implement a bounded scanner or
   equivalent strict parsing.
3. **Parse:** `JSON.parse(text)` (catching all throwables including
   `RangeError`) → `ARCHIVE_PARSE`.
4. **Root:** plain object (not array/null/primitive) →
   `ARCHIVE_ENVELOPE_SHAPE`.
5. **`formatId`** is the exact literal `"npsb"` → else `ARCHIVE_NOT_NPSB`
   (guidance: use Import for NPSL files).
6. **`backupVersion`** per §3 → `ARCHIVE_VERSION`.
7. **Envelope shape:** exactly the seven keys, correct types
   (`ARCHIVE_ENVELOPE_SHAPE`); `exportedAt` ISO 8601; `storage` exactly
   its two integer fields; counts types + all invariants (§4.1) →
   `ARCHIVE_COUNT_MISMATCH`.
8. **Arrays:** `drugs`/`meta` are arrays within row/meta limits →
   `ARCHIVE_LIMIT_EXCEEDED`.
9. **Per entry:** exact entry keys (`ARCHIVE_ENTRY_SHAPE`); `key` string
   (`ARCHIVE_KEY_TYPE`); `value` plain object with own string `id`
   strictly equal to `key` (`ARCHIVE_KEY_MISMATCH`).
10. **Duplicates:** within each store, no repeated `key` →
    `ARCHIVE_DUPLICATE_KEY` with both indices.
11. **Sidecars:** annotation count ≤ global cap; shapes, pointer syntax,
    own-only resolution, duplicates, placeholder matches (§6.3) →
    `ARCHIVE_ANNOTATION_SHAPE` / `ARCHIVE_ANNOTATION_PATH` /
    `ARCHIVE_ANNOTATION_DUPLICATE` / `ARCHIVE_ANNOTATION_PLACEHOLDER`.
12. **Value domain:** no unannotated special numbers (§6.3) →
    `ARCHIVE_VALUE_DOMAIN`; traversal depth ≤ 100 →
    `ARCHIVE_LIMIT_EXCEEDED`. (All other unsupported types are
    structurally impossible after `JSON.parse` — objects are plain, arrays
    dense, no `undefined`/`BigInt`/`Date`/cycles — so validation needs no
    type scan here; the export-side scan (§6.2) is the boundary that
    keeps them out of archives in the first place.)

`restoreRecoveryArchive` **re-runs this entire validation** on the exact
text it is about to apply (the preview may have run earlier).

### 8.3 Preview (read-only, before acknowledgement)

- **Recorded counts** from the archive (validated): total rows,
  `readableAtExport`, `quarantinedAtExport`, `metaRows`.
- **Current build's classification** of the archive's rows (run
  `fromRecord()` over them): readable/quarantined *now* — computed for
  display, **never gating** the restore.
- **Current library now** (session store): records + quarantine — what
  will be replaced.
- **Warnings (non-blocking):** `RECLASSIFICATION_DIFFERS` (recorded ≠
  current classification; both numbers always shown, never claimed
  equal), `STORAGE_VERSION_DIFFERS` (`storage.persistenceVersion` ≠
  current `PERSISTENCE_VERSION`, or `storage.databaseVersion` ≠ current
  `db.verno` — informational), `ARCHIVE_META_UNREADABLE` (a meta row
  fails the current `libraryMetadataSchema`; it will still be restored as
  stored), `ARCHIVE_EMPTY` (0 drug rows — restoring empties the library).

### 8.4 The restore transaction (atomicity contract)

Exactly one Dexie `rw` transaction over `drugs` and `meta`:

```
begin rw(drugs, meta)
  drugs.clear()
  meta.clear()
  for each drugs entry (archive order):  db.drugs.put(value)   // key derived from value.id ≡ entry.key
  for each meta entry  (archive order):  db.meta.put(value)
commit                                   // any throw ⇒ abort
```

- **Rollback:** any failure inside (quota, aborted transaction, unexpected
  error) makes IndexedDB abort the transaction, reverting *both* stores —
  including the `clear()`s — to their exact pre-transaction contents.
  This is the same guarantee `replaceLibrary()`/`importLibrary()` rely on
  (asserted by the existing rollback tests). Outcome: `failed`,
  message "no changes were written; the previous library is intact" plus
  the underlying error (e.g. quota guidance). **No automatic retry.**
- **Raw writes are confined to this operation.** Restoring verbatim rows
  necessarily bypasses `drugSchema`/`assertWritable()` — and *only* here:
  `drugSchema`, `parseNpsl`, `validateNpslFile`, `importLibrary()` and
  `replaceLibrary()` are untouched; ordinary import cannot reach the raw
  path (§2.2). No write happens anywhere else in the restore flow.
- Values written are JSON-domain ⊕ sidecar materialized (§6) — always
  structured-cloneable, so `DataCloneError` is impossible by construction;
  a thrown error is treated as `failed` (rolled back) regardless.
- Closing the tab mid-transaction aborts it (IndexedDB behavior) —
  library unchanged (§14).

### 8.5 Post-commit refresh and the four outcomes

After commit, the session re-reads storage (same as import's refresh).
The store returns one of four distinct outcomes — mapped to distinct UI
states (§11):

| Outcome | Meaning | UI contract |
| --- | --- | --- |
| `rejected` | Validation/preview failed; **no transaction opened** | "The current library was not modified." + error list; alert role |
| `failed` | Transaction aborted and rolled back | "No changes were written — the previous library is intact." + underlying error; alert role; manual retry allowed |
| `ok` | Committed **and** refreshed | Success report: restored counts + post-restore classification (§9); status role |
| `committed-refresh-failed` | **Committed**, but the post-commit session read failed | Text must state the restore **was written to storage**, show the refresh error verbatim, offer a *session refresh* retry/reload. **Never** claim rollback; **never** auto-re-run the restore (mirrors `LibraryImportOutcome`, `store.ts`, and `validation.md` §5 "Honest commit reporting") |

### 8.6 Reclassification under the receiving build

Quarantine stays **derived** (ADR-15) — no persistent flag, no second
store. After restore, the next hydration classifies every restored row
with the *receiving* build's `drugSchema`:

- Rows quarantined at export but readable now → they appear as ordinary
  records; **not an error**, explicitly reported as reclassified.
- Rows readable at export but quarantined now → they stay stored
  untouched, appear in the quarantine report, and the summary shows both
  numbers ("the archive recorded Q quarantined at export; this build
  classifies Q′").
- Restore **never mutates** a row to make the classifications agree, and
  never rejects an archive because the classifications differ (§4.1).

**Persistent quarantine store: rejected for now.** It would duplicate the
raw row's validity truth (two sources to keep in sync on every write),
freeze export-build judgments into data, require its own schema version +
migration, and contradict ADR-15. If a future "user acknowledged this
quarantined row" feature is wanted, that is an explicit per-row data
decision requiring a separate ADR — not a convenience of this format.

---

## 9. Quarantine classification across builds

Summarized contract (normative text lives in §4.1 and §8.6):

1. Export-time classification is a *fact recorded by the exporting build*
   (`counts.readableAtExport` / `quarantinedAtExport`), labeled "at
   export" everywhere it is shown.
2. The receiving build's classification is computed live by the same
   `fromRecord()` hydration uses, labeled "this build".
3. Both numbers are always displayed together; they may legitimately
   differ; neither overwrites or validates the other.
4. Storage content is never adjusted to influence classification.

---

## 10. Error, warning and outcome taxonomy

Ordinary import codes (`PARSE`, `VERSION`, `SCHEMA`, `DUPLICATE_ID`,
`ENVELOPE_FIELDS_DROPPED`, … — `importPipeline.ts`) are untouched and
disjoint from these. Proposed code sets (8B may refine payloads, not the
codes):

**Export (`BACKUP_*` — any occurrence means: no file is produced):**

| Code | Condition |
| --- | --- |
| `BACKUP_READ_FAILED` | Snapshot read failed / unstable under the §7 fallback |
| `BACKUP_UNSUPPORTED_VALUE` | Value outside **D** (store, key, path, type) |
| `BACKUP_UNSUPPORTED_KEY` | Non-string primary key (store, index, type) |
| `BACKUP_VERIFY_FAILED` | Post-serialization verification mismatch (§6.4) |

**Restore validation (`ARCHIVE_*` — no transaction opened):**

| Code | Condition |
| --- | --- |
| `ARCHIVE_TOO_LARGE` | Size over §12 cap |
| `ARCHIVE_PARSE` | Not JSON (incl. `NaN` literal → `SyntaxError`, `RangeError`) |
| `ARCHIVE_DUPLICATE_JSON_KEY` | Duplicate object key in text (+ line/column) |
| `ARCHIVE_NOT_NPSB` | Missing/wrong `formatId` (+ "use Import" guidance) |
| `ARCHIVE_VERSION` | Invalid/unsupported `backupVersion` |
| `ARCHIVE_ENVELOPE_SHAPE` | Missing/unknown top-level key or wrong type (incl. `storage`) |
| `ARCHIVE_COUNT_MISMATCH` | Counts violate §4.1 invariants |
| `ARCHIVE_LIMIT_EXCEEDED` | Row/meta/annotation/depth cap exceeded |
| `ARCHIVE_ENTRY_SHAPE` | Entry keys wrong or `value` not a plain object |
| `ARCHIVE_KEY_TYPE` | `key` not a string |
| `ARCHIVE_KEY_MISMATCH` | `key` ≠ own `value.id` (or `id` absent/not a string) |
| `ARCHIVE_DUPLICATE_KEY` | Repeated key within one store (+ both indices) |
| `ARCHIVE_ANNOTATION_SHAPE` | Malformed annotation object / unknown `kind` |
| `ARCHIVE_ANNOTATION_PATH` | Invalid pointer, unresolvable or non-own segment |
| `ARCHIVE_ANNOTATION_DUPLICATE` | Same pointer twice in one entry |
| `ARCHIVE_ANNOTATION_PLACEHOLDER` | Placeholder type mismatch (§6.3) |
| `ARCHIVE_VALUE_DOMAIN` | Unannotated special number after parse |

**Restore execution:** `RESTORE_WRITE_FAILED` (aborted + rolled back,
previous library intact), `RESTORE_REFRESH_FAILED` (committed; refresh
failed — maps to the `committed-refresh-failed` outcome, §8.5).

**Preview warnings (non-blocking):** `RECLASSIFICATION_DIFFERS`,
`STORAGE_VERSION_DIFFERS`, `ARCHIVE_META_UNREADABLE`, `ARCHIVE_EMPTY`.

Every error payload carries the store, row key (or entry index) and
property path where applicable — enough to locate the offending data
without a debugger.

---

## 11. User interaction and destructive acknowledgement

Dedicated **Recovery tab** in the Import/Export view (third tab next to
Import and Export — proposed testid `tab-recovery`), visually and
textually separate from NPSL/CSV import choices. The archive is never
offered inside the ordinary import file picker or mode selector.

**Export card:** "Create full backup (.npsb)" → runs §7 → success report
(total rows; readable/quarantined at export; "this file is local and not
authenticated or checksummed — verify where it came from") or an error
alert listing `BACKUP_*` failures (store/key/path/type per row). A failed
export shows **no** success state and offers **no** file — never a
partial or "complete backup" message.

**Restore card (destructive flow):**

1. File picker → parse + full validation (§8.2). Rejection → `rejected`
   report; nothing else appears.
2. Preview (§8.3): three count groups clearly labeled — *archive recorded
   at export*, *this build classifies*, *current library* — plus warnings.
3. Explicit acknowledgement checkbox (proposed `recovery-acknowledge`)
   whose **label embeds the numbers**, e.g. "I understand this will
   permanently replace my current library — N records and Q quarantined
   rows — with the archive contents (M rows)". The confirm button
   (proposed `recovery-restore-confirm`) stays disabled until it is
   checked; the button text itself names the destructive action
   ("Restore backup — replaces everything"). No vague "OK/Continue".
4. Confirm → progress/busy state → exactly one of the four outcome
   reports (§8.5), announced with `role="alert"` (failure/rejection) or
   `role="status"` (success), matching the import panel's patterns
   (`ImportPanel.tsx`). `committed-refresh-failed` shows a refresh-retry
   control that re-runs **only** the session refresh, never the restore.
5. A double-click or repeated confirm while busy is ignored (in-flight
   guard). Automatic re-execution never happens.

No automatic repair, deletion or reclassification of records at any
point; quarantine rows remain visible in the existing quarantine report
(`DrugLibraryView.tsx`). Everything is local: no backend, telemetry,
cloud upload or remote storage (consistent with ADR-11/ADR-12).

---

## 12. Resource limits and security

| Limit | Value | Why this number |
| --- | --- | --- |
| Archive text (`MAX_ARCHIVE_BYTES`) | 64 MiB (67 108 864 UTF-8 bytes) | Real libraries are orders of magnitude smaller (hundreds of rows ≈ <1 MiB); 64 MiB bounds `JSON.parse` memory/CPU in the tab while remaining far above any legitimate library. Checked before reading where possible and on the decoded text |
| `drugs` entries (`MAX_DRUG_ROWS`) | 100 000 | ~100× a large plausible library; bounds per-row O(n) work (fidelity scan + classification + preview) even when rows are tiny (text cap alone could allow far more small rows) |
| `meta` entries (`MAX_META_ROWS`) | 1 000 | The application writes exactly one metadata row; 1000× headroom while bounding a pathological array |
| `specialNumbers` annotations (`MAX_SPECIAL_NUMBER_ANNOTATIONS`) | 1 000 000 total | Pointer strings can be a few bytes each, so the text cap alone would permit tens of millions; this bounds per-annotation resolution work independently |
| Traversal depth (`MAX_DEPTH`) | 100 | Natural record nesting is <10; unknown fields get 10× headroom; prevents stack exhaustion in recursive scans. The duplicate-key scanner (§8.2/2) must be iterative/stack-based |

Constant names are proposed for Phase 8B (their location is an open
decision, §15.5).

Exceeding any limit → the corresponding `ARCHIVE_*`/`BACKUP_*` rejection
before writes. Validation cost is bounded by these limits; if a
worst-case file still blocks the main thread noticeably, 8B validates in
bounded chunks between frames — the ordering rules (validate fully before
writing) are unaffected.

**Security posture (v1):**

- **No integrity checksum, no signature.** Plainly: valid JSON plus
  structural validation proves only that the text conforms to this
  schema — it does **not** prove the file is unmodified, complete or
  authentic. A bit-flipped or edited archive that still validates is
  restored as-is. Users must obtain backups they produced themselves or
  from a trusted source; treat found archives like any untrusted file.
  (Export-time verification (§6.4) guards creation bugs, not later
  tampering.)
- **Untrusted-input handling:** every check in §8.2 precedes any write;
  sizes/counts/depth are capped; the format is data-only (no code
  execution, no class revival); pointer resolution is own-property-only
  (§6.3); duplicate keys are rejected rather than silently collapsed;
  file names for download pass `safeFileName()` (`fileIo.ts`).
- **Local-only:** the feature adds no network, telemetry or storage
  outside IndexedDB and the user-initiated download.
- **Destructive-action safety:** preview + count-embedding acknowledgement
  + in-flight guard + no auto-retry (§11).

---

## 13. Compatibility, integrity and future extension

- **Two independent version spaces.** `backupVersion` evolves only with
  this format; NPSL `formatVersion`/`schemaVersion` never change because
  of it, and vice versa. Rule: same major, file minor ≤ reader minor
  (§3); rejections are explicit, never partial.
- **Strict envelope + minor bumps.** New optional top-level fields (e.g.
  a future `checksum`) require a `backupVersion` minor bump; older
  readers already reject newer minors, so strictness costs no
  compatibility within a supported version.
- **New object stores are a format obligation.** v1 covers `drugs` and
  `meta`, which are the complete store set of schema versions 1–2. When a
  future database version adds an object store, the backup format **must**
  be extended (entry array + counts field + minor bump) in the *same*
  change — otherwise exports would silently stop being complete snapshots.
  This is a normative rule for future schema PRs.
- **Integrity:** none in v1 (§12). If later desired, an in-envelope
  checksum needs its own decision covering algorithm *and* canonical
  byte definition (which bytes are hashed when the checksum field itself
  must be excluded) — an envelope change, hence a minor bump. A checksum
  would still not provide authenticity (an attacker rewrites it); a
  signature would require key management — out of scope for a local tool.
- **Widening the value domain** (§6.2) likewise requires a `backupVersion`
  bump plus updated fidelity tests in the same change.
- **`.npsb` is never repurposed:** the extension and `formatId` mean this
  recovery archive only.

---

## 14. Failure and recovery scenarios

| # | Scenario | Behavior (contract) |
| --- | --- | --- |
| 1 | Archive from a newer `backupVersion` minor / major | `ARCHIVE_VERSION`, no writes; guidance "update the application" / "not supported" |
| 2 | Archive from an older supported minor | Restored (within-major backward compatibility) |
| 3 | Truncated or corrupted file | `ARCHIVE_PARSE`, no writes |
| 4 | Bit-rot inside a still-valid archive | **Not detected** (no checksum, §12/§13) — restored as-is; documented limitation |
| 5 | `.npsl`/`.json`/`.csv` file chosen in Restore | `ARCHIVE_NOT_NPSB` + "use Import"; Import of that file still works as today |
| 6 | `.npsb` file chosen in ordinary Import | `parseNpsl` `SCHEMA` error (no `formatVersion`); zero writes |
| 7 | Duplicate JSON keys smuggled in text | `ARCHIVE_DUPLICATE_JSON_KEY` (+ line/column) before any write |
| 8 | Duplicate entry keys | `ARCHIVE_DUPLICATE_KEY` before any write — prevents `put`'s silent overwrite |
| 9 | Archive exceeds any §12 limit | `ARCHIVE_TOO_LARGE` / `ARCHIVE_LIMIT_EXCEEDED`, nothing read into a write path |
| 10 | Export encounters a `Date`/`BigInt`/cycle/non-string key | Fails with `BACKUP_UNSUPPORTED_VALUE`/`BACKUP_UNSUPPORTED_KEY` naming store, key, path, type; **no file**; no partial backup; no auto-repair (user resolves the row deliberately) |
| 11 | Tab closed mid-export | Nothing was written (export is read-only) |
| 12 | Quota/full or other error inside the restore transaction | Abort → full rollback incl. clears → previous library intact → `failed` report; manual retry after freeing space |
| 13 | Tab closed mid-restore | IndexedDB aborts the open transaction → library unchanged |
| 14 | Post-commit refresh failure | `committed-refresh-failed`: states the restore **was committed**, shows the refresh error, offers refresh retry/reload; never a rollback claim; never an automatic second restore |
| 15 | Concurrent edit during export | Archive is one transaction-start snapshot; counts ≡ entries by construction (§7) |
| 16 | Archive's rows quarantine differently under the receiving build | Restore succeeds; both classifications reported; newly quarantined rows stay stored and visible (§8.6/§9) |
| 17 | Multiple metadata rows in the archive | All restored; the app keeps reading the first row by key order (`getLibraryMetadata()` semantics unchanged) |
| 18 | Empty archive (`drugRows: 0`) | `ARCHIVE_EMPTY` warning + acknowledgement states the counts; restore yields an empty library — explicit, not silent |
| 19 | Receiving build later bumps DB schema (v3) | Dexie's upgrade runs on *pre-restore* data; restored rows keep the archive's `persistenceVersion` and are reclassified by current hydration — invalid ones are reported, never backfilled by restore |
| 20 | Restore on a library the user did not intend to replace | Prevented by §11 (preview counts + embedded acknowledgement), not by the format |

---

## 15. Future test matrix (Phase 8B — none of this exists yet)

All fixtures are **synthetic** (fictional ids/names/values, tagged as test
fixtures); no real pharmacology. Existing gates stay green unchanged:
`npm run typecheck`, `npm run typecheck:e2e`, `npm run lint`, `npm test`,
`npm run build`, `npm run test:e2e`.

### 15.1 Serialization / unit tests

| Case | Assertion |
| --- | --- |
| Valid raw row + quarantined raw row round trip | export → parse → materialize → deep-equal `E` (§6.1), including `persistenceVersion` and origin values exactly as stored |
| Unknown fields at root/`identifiers`/`targets[i]`/parameter/`provenance`/`pharmacokinetics`/metadata | Present verbatim after round trip |
| Sidecar, each `kind` (`-0`, `NaN`, `Infinity`, `-Infinity`) in object properties and array elements | Placeholder emitted per §6.3 table; restored value `Object.is`-equal to source; `-0` vs `0` distinguishable in both directions |
| `Object.is` equality helper itself | `E(-0, 0)` false, `E(NaN, NaN)` true, array positions/length preserved, key-order-insensitive object compare |
| Unsupported types: `undefined` property, `BigInt`, `Date`, `RegExp`, `Map`, `Set`, `Error`, `ArrayBuffer`, typed array, function value, sparse array, cycle, non-plain prototype | Export fails `BACKUP_UNSUPPORTED_VALUE` with correct `store`, `key`, RFC 6901 `path`, `type`; no output text |
| Non-string storage key (e.g. numeric id injected directly) | Export fails `BACKUP_UNSUPPORTED_KEY` with index/type; restore rejects `ARCHIVE_KEY_TYPE` |
| Pointer escaping | Keys containing `/` and `~` encode as `~1`/`~0` and resolve; invalid escapes, non-pointer, root pointer, unresolvable path, non-own traversal (`/__proto__/x`, `/constructor`) → `ARCHIVE_ANNOTATION_PATH` |
| Annotation malformations | Unknown `kind`, extra/missing annotation keys → `ARCHIVE_ANNOTATION_SHAPE`; duplicate pointer → `ARCHIVE_ANNOTATION_DUPLICATE`; wrong placeholder (string/null/`1` where `0` expected, non-null where `null` expected) → `ARCHIVE_ANNOTATION_PLACEHOLDER`; unannotated `-0`, `1e400`→`Infinity` literal → `ARCHIVE_VALUE_DOMAIN` |
| Verification step | Injected serializer fault → `BACKUP_VERIFY_FAILED`, no download text |
| Oversized/deep inputs | >64 MiB text → `ARCHIVE_TOO_LARGE`; >100 000 rows / >1 000 meta / >1 000 000 annotations / depth >100 → `ARCHIVE_LIMIT_EXCEEDED` |
| Malformed JSON | `{`, trailing garbage, `NaN` literal → `ARCHIVE_PARSE` |
| Duplicate JSON keys | Duplicated at envelope level and nested (plus a negative test: `"key":` appearing *inside* a string value does not trigger) → `ARCHIVE_DUPLICATE_JSON_KEY` with line/column |
| Version errors | `backupVersion` `"2.0.0"` (major), `"1.1.0"` (minor), `"1.0.x"`, `"x"`, missing → `ARCHIVE_VERSION`; `"1.0.0"` accepted; the pure version-rule helper also accepts an older file minor against a higher reader constant (file `1.0.0` vs reader `1.1.0`) |
| Envelope errors | Missing key, extra key, wrong `formatId`, wrong counts types, each counts invariant broken → `ARCHIVE_ENVELOPE_SHAPE` / `ARCHIVE_NOT_NPSB` / `ARCHIVE_COUNT_MISMATCH` |
| Key errors | `key` ≠ `value.id`, missing `id`, duplicate keys (both indices reported) → the §10 codes; empty-string key accepted as a string key |

### 15.2 Repository tests (`fake-indexeddb`, real repository)

| Case | Assertion |
| --- | --- |
| Both stores exported | Seed 1 valid + 1 quarantined row (direct `put`, as existing tests do) and 2 `meta` rows → archive contains every row of both stores; `counts` match arrays; keys equal `cursor.key`s |
| Raw restore without normalization | Restore → `db.drugs.toArray()` deep-equals archive values (no `persistenceVersion`/timestamp stamping, no schema defaults added) and survives close/reopen unchanged |
| Key preservation | Original keys (incl. unicode/empty-string) reachable via `get(key)`/`keys()` after restore; `key ≡ value.id` asserted |
| Duplicate/mismatched/non-string keys rejected | Each case → named code, and `db.drugs.count()` / `db.meta.count()` unchanged afterwards |
| Transaction failure mid-write | Force a failure after `clear()`+partial puts (e.g. stub the final `meta.put` to throw once) → both stores byte-identical to pre-restore contents; outcome `failed` |
| Reclassification on restore | Archive whose rows the current schema quarantines → restore `ok`; `getAllDrugs()` returns them in `quarantine`, stored count unchanged. Archive recorded as quarantined-at-export but valid under current schema → restored as readable, no rejection. Counts-differs warnings, never rejections |
| Ordinary paths unaffected | `importLibrary` on `.npsb` text → `SCHEMA`/`PARSE` error, zero writes; `replaceLibrary` still rejects invalid rows; `exportLibrary` still excludes quarantine; full existing suites unchanged |
| All meta rows | Restored verbatim; `getLibraryMetadata()` returns the first row by key order; extra rows present in storage |
| Snapshot consistency | Counts in archive ≡ entries even when a concurrent `put` lands after the snapshot (§7 fallback under test) |

### 15.3 Component tests (store + Import/Export view)

| Case | Assertion |
| --- | --- |
| Preview counts | Three count groups rendered distinctly with "at export" vs "this build" vs "current library" labels |
| Acknowledgement gating | Confirm disabled until `recovery-acknowledge` is checked; label embeds the record/quarantine counts |
| Rejection/failure announcements | `role="alert"` reports; explicit "the current library was not modified" / "no changes were written" wording per outcome |
| `committed-refresh-failed` | Report states the restore was committed (no rollback wording), shows the refresh error, exposes refresh-retry; spy proves the restore action is **not** invoked again (precedent: `ImportExportView.test.tsx` committed-refresh-failed test) |
| Export failure honesty | With a poisoned row: error list shows store/key/path/type; `downloadTextFile` **not** called; no success status; no "complete backup" text |
| Export success reporting | Shows total/ readable/quarantined counts + the not-authenticated notice |
| Ordinary export unchanged | `.npsl`/`.json`/`.csv` exports still exclude quarantine and still show `export-quarantine-warning` with the excluded count |

### 15.4 End-to-end tests (Playwright, real IndexedDB, isolated context)

| Case | Assertion |
| --- | --- |
| Export complete snapshot | Seed one valid record via UI + one invalid row via direct IndexedDB write (existing pattern) → Recovery export → downloaded `.npsb` parses with `drugs.length` equal to the store's row count (valid **and** quarantined) |
| Clear → restore → reload | Restore the archive over an emptied library → reload → valid record visible; quarantined row present in storage and listed in the quarantine report |
| Restore rejection is inert | Truncated/edited archive → visible rejection with code; record count and content unchanged after reload |
| Commit-then-refresh-failure | Restore commits, forced post-commit refresh failure → report says committed, offers refresh retry, and **no second restore runs automatically** (see open decision below — deterministic injection needs an approved test hook; component coverage is authoritative if none) |
| Mutual rejection | `.npsb` text in ordinary Import → visible schema error, library unchanged; `.npsl` file in Restore → `ARCHIVE_NOT_NPSB` guidance |
| Accessibility | axe scans over the Recovery tab states (preview, acknowledgement, outcome), consistent with the existing 12-state a11y spec |

### 15.5 Open decisions for Phase 8B (honest list)

1. **E2E injection for post-commit refresh failure** — no deterministic
   hook exists in the running app today. 8B must either add a narrowly
   scoped, documented test hook (a runtime code change, approved
   separately) or record the component test as the authoritative coverage
   and document the E2E gap. Do not fake the test.
2. **Duplicate-key detector design** — behavior is fixed (§8.2/2) but the
   scanner's exact structure is 8B work; it must be string-aware,
   iterative and bounded by §12 limits.
3. **Final API/error-payload names** — `exportRecoveryArchive()`,
   `previewRecoveryArchive()`, `restoreRecoveryArchive()`,
   `LibraryRestoreOutcome`, module location (proposed
   `src/data/recovery/`) and whether codes ride on `RepositoryError` or a
   dedicated error type are indicative until 8B review.
4. **Snapshot transaction verification** — §7's single-transaction claim
   is specified from IndexedDB semantics plus this repository's existing
   multi-await transaction precedent; 8B must prove it under
   fake-indexeddb *and* Chromium before relying on it (the §7 fallback is
   the defined behavior if it does not hold).
