# Calculation engine

Contract and design rules for the scientific core. The engine is pure,
independently testable and completely decoupled from React, Zustand,
IndexedDB and the DOM.

Implemented contract: `src/engine/types.ts`. All three MVP models and their
curve generators are implemented (phase 2): `src/engine/pk`,
`src/engine/occupancy`, `src/engine/dose-response`, plus shared layers
`src/engine/numeric`, `src/engine/validate`, `src/engine/units`,
`src/engine/trace` and `src/engine/curve`. Public API surface:
`src/engine/index.ts`.

---

## 1. Purity rules

A calculation function may:

- accept a plain input object,
- use Decimal.js / `Math` and the unit catalog,
- return a `CalculationReport`.

It may **not**:

- import React, Zustand, Dexie or any browser API,
- read the clock (timestamps are injected by callers, if needed),
- mutate its inputs,
- throw for user-fixable conditions — invalid input is returned as data
  (`ok: false` + errors), so the UI can render it and tests can assert it,
- invent, default or interpolate any pharmacological parameter.

---

## 2. The report — results are never bare numbers

```ts
type CalculationReport =
  | { ok: true;  result: CalculationResult }
  | { ok: false; model: ModelId; errors: readonly CalculationError[] }

interface CalculationResult {
  model: ModelId                 // 'occupancy.single-site'
  modelLabel: string             // 'Single-site receptor occupancy'
  formula: string                // 'Occupancy = [D] / ([D] + Kd)'
  inputs: CalculationInput[]     // symbol, label, value, unit, provenance?
  trace: TraceStep[]             // ordered derivation, inputs → outputs
  outputs: CalculationValue[]    // symbol, label, value, unit
  assumptions: string[]          // model assumptions, always shown
  warnings: CalculationWarning[] // e.g. 'MODEL_RESULT_NOT_CLINICAL'
}
```

Every user-visible result panel is built from exactly these fields:
inputs, formula, intermediates, final result, assumptions, warnings — as
required by the specification.

### Trace steps

```ts
interface TraceStep {
  index: number
  label: string        // 'Elimination constant'
  expression: string   // 'k = ln(2) / t½'
  substituted: string  // 'ln(2) / 6 h'
  result: CalculationValue  // { value, unit }
}
```

The trace is the transparency mechanism: a user must be able to follow a
result from input to output without reading source code. Traces are built by
`src/engine/trace` helpers so every model produces them in the same style.

### Inputs carry provenance

`CalculationInput.provenance` is set when the input came from a library
record (so the report shows *why* that Kd is trusted) and absent for values
typed into the calculator. The report therefore distinguishes literature-backed
and user-typed inputs without assuming either is correct.

---

## 3. Error taxonomy

| Code | Meaning | Example trigger | Emitted by (phase 2) |
| --- | --- | --- | --- |
| `MISSING_PARAMETER` | Required input absent | no `halfLife`, Hill `n` missing (never defaulted) | all models + curve generators (`range` missing) |
| `NOT_A_NUMBER` | Input is NaN/±∞ | unparsed form state | all models |
| `NEGATIVE_VALUE` | Negative where impossible | `Kd = -3 nM`, `n = -1`, `t < 0` | all models |
| `ZERO_NOT_ALLOWED` | Zero divisor/parameter | `EC50 = 0`, `Kd = 0`, `t½ = 0`, `n = 0`, `k = 0` | all models |
| `OUT_OF_RANGE` | Outside model/curve domain | curve `min > max`, `min < 0`, log scale with `min ≤ 0` | `src/engine/curve` validation |
| `UNKNOWN_UNIT` | Unit not in catalog | `"molars"` | all models |
| `INCOMPATIBLE_UNITS` | Dimension mismatch | `[D]` in `mg/L`, `Kd` in `nM`; `n` given as `%`; `E0`/`Emax` unit mismatch; molar↔mass concentration (needs MW — never invented) | all models |
| `CONFLICTING_PARAMETERS` | Mutually exclusive parameters both present | both `t½` and `k` supplied to the PK model (from JavaScript callers; TypeScript callers cannot express this) | PK model |
| `NUMERICAL_ERROR` | Computation produced no usable output | *reserved* — defensive invariant in curve generators, not reachable through validated inputs | — (reserved) |
| `MODEL_NOT_APPLICABLE` | Model cannot describe inputs | *reserved* — the answer for a requested calculation no model may perform (e.g. dose → effect) | — (reserved, see §7) |

Errors are aggregated (all problems reported at once), each with a
`parameter` symbol so the UI can highlight the offending field.

**Zero semantics** (uniform across models): `C0`, `t`, `[D]`, `E0`, `Emax`
may be zero; `t½`, `k`, `Kd`, `EC50`, `n` may not (each would silently destroy
or invert the mathematics). Negative values are rejected everywhere they are
dimensionally meaningless; signs are allowed wherever the caller's convention
uses them (`E0`, `Emax`).

Warnings (non-fatal):

- `MODEL_RESULT_NOT_CLINICAL` — the result is a mathematical model output,
  not a clinical prediction. Emitted by all three models.
- `MODEL_LIMITATION` — e.g. "One-compartment first-order model; real human
  pharmacokinetics may be multi-compartmental." Emitted by all three models.
- `NUMERICAL_UNDERFLOW` — a computed value is mathematically non-zero but
  rounds to `0` at double range (e.g. PK concentration far past `t½`, Hill
  tail below ~`1e-308`). Reported as 0 **with** the warning, never silently.
- `NUMERICAL_OVERFLOW` — a computed intermediate exceeds the reportable
  double range (e.g. `(EC50/[D])^n` with huge `n`). The model falls back to
  the mathematical limit where one exists and warns.
- `LOG_Y_AXIS_NOT_REPRESENTABLE` — a log y-axis was requested but some
  sampled points are ≤ 0 or non-finite (baseline zeros, underflowed points,
  negative effects). The curve comes back with its data unchanged and the
  conflict reported once; the chart layer falls back to a linear y-axis or
  refuses the view. The engine never edits a result to satisfy an axis.

---

## 4. Model registry

Phase-1 contract (the end state once calculator input schemas exist):

```ts
interface EngineModel<I> {
  readonly id: ModelId
  readonly label: string
  readonly formula: string
  readonly assumptions: readonly string[]
  calculate(input: I): CalculationReport
}
```

**Phase-2 implementation decision:** the registry holds
`ModelDescriptor` values only — `id`, `label`, `formula`, `assumptions`,
`warnings`, no `calculate` wrapper:

```ts
// src/engine/registry.ts
export const MODELS: Record<ModelId, ModelDescriptor> = { ... }
```

Why: an `EngineModel<I>` wrapper needs each model's input schema next to its
descriptor. The calculator (phase 4) landed Zod draft schemas that mirror the
engine input types field-for-field, but they live with the feature
(`src/features/calculator/schemas.ts`), not in the engine — and wiring
calculate functions into the registry while models import descriptor
constants from it would create a module cycle. Models are exported as plain
functions today (`calculateFirstOrderPK`, `calculateReceptorOccupancy`,
`calculateHillResponse`); the `EngineModel` wrapper remains a mechanical
addition if engine-owned input schemas land. A test
(`src/engine/registry.test.ts`) guards key/descriptor drift.

Implemented models:

| Model id | Formula | Required inputs | Outputs |
| --- | --- | --- | --- |
| `pk.first-order-one-compartment` | `C(t) = C0 · e^(−k·t)`, `k = ln(2)/t½` | `C0` (concentration), `t` (time), and **exactly one of** `t½` or `k` (time / rate) | `C(t)` in input concentration unit, `k` (`1/time`), `t½` (time) |
| `occupancy.single-site` | `Occupancy = [D] / ([D] + Kd)` | `[D]` concentration, `Kd` (same dimension) | fraction `Occ` (`1`) + `Occ%` (`%`) |
| `dose-response.hill` | `E = E0 + (Emax · [D]^n) / (EC50^n + [D]^n)` | `E0`, `Emax` (one shared effect unit), `EC50` (concentration), `n` (unit exactly `1`), `[D]` (concentration ≥ 0) | `E` (effect unit), `f` (`1`) |

Unit expectations are checked by `src/engine/validate` + `src/engine/units`
(`UNKNOWN_UNIT` / `INCOMPATIBLE_UNITS`); the concrete catalog lives in
`src/domain/pharmacology/unit-catalog.ts` (molar + mass concentration, time,
rate `1/h`, dimensionless `1`, percent `%`, plus caller labels for effects).
Conversions between compatible units are explicit trace steps; conversions
that would need a molecular weight are always rejected.

The Hill equation is computed in the stable form
`f = 1 / (1 + (EC50/[D])^n)` with the algebraically identical canonical
formula shown in the descriptor; `[D] = 0` takes the explicit `f = 0` branch.

---

## 5. Curves and the chart boundary

The engine produces chart-agnostic data. Implemented in
`src/engine/curve` (shared sampling + range validation) and per-model
`curve.ts` generators (`generatePKCurve`, `generateOccupancyCurve`,
`generateHillCurve`), all returning `CurveGenerationResult` — a
`CalculationReport`-shaped success carrying a `CurveData`, or
`ok: false` + errors:

```ts
interface CurveData {
  model: ModelId
  xLabel: string; yLabel: string
  xUnit: string;  yUnit: string
  xScale: 'linear' | 'log'
  yScale: 'linear' | 'log'
  series: CurveSeries[]
  warnings?: CalculationWarning[]   // e.g. NUMERICAL_UNDERFLOW at N points
}

interface CurveSeries {
  id: string                        // stable id, e.g. 'pk.concentration'
  name: string
  seriesType: 'model' | 'observed'   // calculated vs measured data
  points: { x: number; y: number }[]
  xUnit: string; yUnit: string
  provenance?: Provenance
  source?: string
}
```

Flow: `model → generate*Curve() → CurveData → chart adapter → Plotly`.

Rules:

- **The domain is required, never invented.** `CurveOptions.range`
  (`{ min, max, points? }`) is mandatory; a missing range is a
  `MISSING_PARAMETER` error, not a default window. Validation: finite values,
  `min < max`, `min ≥ 0`, and `min > 0` for a log x-axis.
- Defaults (documented, overridable): 200 points (bounded 2–5000),
  **linear x for PK time courses**, **log x for concentration axes**
  (occupancy, Hill), linear y. Scale is a chart setting, not a calculation
  input; changing it re-renders existing points and never changes results.
- **Every curve point is evaluated through the full scalar model** at that
  x (converted to the input's unit), so the curve is the scalar calculation
  by construction — a test asserts point-wise equality.
- Points that underflow/overflow are not dropped: they are reported
  (`y = 0` with a `NUMERICAL_UNDERFLOW` curve warning, message includes the
  affected point count).
- **Log y-axis conflicts are reported, never repaired.** Valid input
  legitimately produces `y = 0`, negative or underflowed points; when
  `yScale: 'log'` meets them the engine emits one
  `LOG_Y_AXIS_NOT_REPRESENTABLE` warning (message includes the affected
  point count) and keeps every point exactly as calculated — no filtering,
  no epsilon clamping, no recomputation. A linear y-axis never warns, and
  unknown scale strings are rejected as `OUT_OF_RANGE` (`xScale`/`yScale`).
- **Plotly never computes pharmacology.** No formula appears in a chart
  component; swapping Plotly for another library touches only the adapter.
- `seriesType` exists from day one so future observed/literature points can
  share a chart with the model curve while remaining visually and semantically
  distinguishable.

---

## 6. Numerical policy

- Scalar arithmetic that affects displayed values (+, −, ×, ÷, powers,
  `exp`, `ln`) is performed with **Decimal.js** (`docs/decisions.md` §6,
  `src/engine/numeric/decimal.ts`).
- Report rounding: `roundForReport()` renders every reported number at
  **12 significant digits** and returns a loss flag
  (`none | underflow | overflow`). Underflow (mathematically non-zero → 0 at
  double range) surfaces as `NUMERICAL_UNDERFLOW`; overflow of intermediates
  surfaces as `NUMERICAL_OVERFLOW`. Sub-range doubles (denormals down to
  `5e-324`) are reported normally.
- **One loss policy for every model**: each value that leaves the engine —
  scalar outputs *and* trace step results — is rounded through
  `roundForReport()` (or `roundNonZero()` where the true value cannot be
  zero), and every loss produces a structured warning naming the quantity
  (`noteRoundingLoss()` in `src/engine/numeric/decimal.ts`). A mathematical
  zero produces no warning; a non-zero value the double range cannot hold
  always does. That is what keeps "exactly 0" distinguishable from
  "non-zero but unrepresentable".
- `roundNonZero()` exists because Decimal.js `exp`/`pow` can collapse a
  strictly positive quantity (e.g. `e^(−k·t)`, `r^n` with `r > 0`) to an
  *exact* Decimal zero/∞ outside its own exponent range — a collapse
  `roundForReport()` alone would misclassify as a faithful zero.
- Documented limiting forms (always paired with a warning): overflowing
  `r^n` → `f` through its exact limit `0`; underflowing `r^n` for `r < 1`
  → `f` through its exact limit `1`; collapsed `e^(−k·t)` → `C(t) = 0` for
  `C0 > 0`. Trace and outputs round each quantity exactly once, so they can
  never disagree.
- The UI formats for display; the engine fixes the digits so two runs of the
  same input are byte-identical.
- Curve sampling may evaluate through the same code path with doubles where
  exact; it is visualization sampling — reported scalar outputs always come
  from the Decimal path. Chart geometry uses plain doubles (`docs/decisions.md` §6).
- Trace steps are 1-based, ordered, and each shows expression, substituted
  values (with units) and result — including explicit unit-conversion steps.
- Precision tests assert stability (see [testing.md](testing.md)).

---

## 7. Scientific boundary (enforced by model design)

The engine contains no model that maps:

- dose → clinical effect
- receptor occupancy → subjective effect
- plasma concentration → brain occupancy

such a model would require an explicit validated formulation plus all of its
parameters. Without them, `MODEL_NOT_APPLICABLE` is the answer — the code is
part of the taxonomy now and is documented as *reserved*: the engine has no
producer — the calculator (phase 4) renders it only as the display code for
engine errors that map to no specific field. The Hill model
outputs `E` — a dimensionless mathematical response scaled by user-supplied
`E0`/`Emax` — and is labeled a model result, never "efficacy".

Parameter-kind discipline is structural, not cosmetic:

- `Kd`, `Ki`, `EC50`, `IC50` are different quantities. The occupancy input
  has **no `ki` field** and the Hill input has **no `ic50` field**
  (`@ts-expect-error` tests lock this), so neither can be silently
  substituted. Missing parameters are reported, never defaulted — in
  particular the Hill coefficient `n` has no default anywhere in the engine.

Adding a future model means: new model function + `ModelDescriptor`,
input schema, assumptions list, warnings, and the full test matrix — not a
UI change.
