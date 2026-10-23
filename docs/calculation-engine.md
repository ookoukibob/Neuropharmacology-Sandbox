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

---

## 8. Dynamic simulation (phase 41) — a separate boundary

A scalar calculation answers "what is this one number". A simulation answers
"how does this system evolve in time". The two share the purity rules, the
error taxonomy style and the reporting helpers, and nothing else — a sequence
of states is not squeezed into `CalculationReport`.

**Boundary and files**

| Module | Responsibility |
| --- | --- |
| `src/engine/simulation/types.ts` | Contracts only: ODE system, solver settings, scenario, events, samples, result, errors |
| `src/engine/simulation/solver.ts` | Adaptive Dormand–Prince 5(4); knows no pharmacology |
| `src/engine/simulation/events.ts` | Event validation, total ordering, infusion sessions, state jumps |
| `src/engine/simulation/units.ts` | Canonical units, conversion factors, shared helpers |
| `src/engine/simulation/models/two-compartment-pk.ts` | States, equations, observables, assumptions |
| `src/engine/simulation/simulate.ts` | Orchestration, sampling, diagnostics, invariants, report |

`src/engine/index.ts` re-exports the public surface; simulation model ids use
the same dotted convention as `ModelId` (`pnk.two-compartment-iv`).

**Why floating point here but Decimal there.** See ADR-23: the adaptive
solver's error estimator is defined for finite precision, so integration runs
in IEEE-754 doubles with finiteness checks at every boundary, while displayed
values still pass through `roundForReport` (12 significant digits). Scalar
models keep Decimal.js unchanged.

### 8.1 Model equations

Canonical units for the whole simulation: time **h**, amount **mg**, volume
**L**, clearance **L/h**, concentration **mg/L**, infusion rate **mg/h**.

States in fixed order: `A_c` (central), `A_p` (peripheral), `A_e`
(cumulative eliminated), `A_in` (cumulative input).

```
C_c = A_c / V_c                           C_p = A_p / V_p
dA_c/dt  = R_in(t) − CL·C_c − Q·(C_c − C_p)
dA_p/dt  = Q·(C_c − C_p)
dA_e/dt  = CL·C_c
dA_in/dt = R_in(t)
```

A bolus of D raises `A_c` and `A_in` by D; an infusion contributes its rate
to `R_in` between start and stop; `R_in` is the sum of the active rates.
`Q = 0` decouples the compartments (used as an analytical oracle), `CL = 0`
disables elimination. Elimination is central-only; distribution is linear;
no absorption, metabolism, binding, tissue distribution, brain compartment or
effect site is modelled. The central concentration is a compartment
concentration — not a free (unbound) and not a CNS concentration.

**Initial conditions and the mass-balance reference (ADR-25).** The scenario's
`initialState` is the state at `startTime` **before any event**;
`A_e` and `A_in` start at exactly 0. Every dose — including one at
`startTime` — is applied once by the scheduler, to both the physical amount
and `A_in`. The invariant checked for every reported sample is

```
A_c + A_p + A_e − (A_c(0) + A_p(0)) − A_in(t) ≈ 0
```

with tolerance `50 · (attempts + 1) · (atol + rtol · scale)`, `scale` being
the largest mass the run can hold (`A_ref + max |A_in|`). `A_e` is integrated
as a state, never reconstructed from the output grid, so the residual
measures integration error only.

### 8.2 Solver

Adaptive **Dormand–Prince 5(4)** (DOPRI5) with FSAL. The tableau lives in one
place (`solver.ts`). Per component:

```
s_i = atol + rtol · max(|y_i|, |y_i^(5)|)
E   = sqrt( (1/n) · Σ (e_i / s_i)² )      e = h · Σ (b5_j − b4_j) · k_j
```

A step is accepted when `E ≤ 1`. The next step uses
`h·min(5, max(0.2, 0.9·E^(−1/5)))` (5 for `E = 0`), never growing inside a
rejection. Settings are explicit — `absoluteTolerance`, `relativeTolerance`,
`initialStep`, `minStep`, `maxStep`, `maxSteps`; no defaults are applied to
a scenario. Every target time is reached exactly (the step is clipped), and
the solver never steps across an event boundary.

**Failure modes** (all structured, never a partial curve): invalid settings,
non-increasing targets, a derivative of the wrong length
(`INCONSISTENT_DERIVATIVE_DIMENSION`, a programmer error surfaced as data),
non-finite derivative or state (`NUMERICAL_FAILURE`), a step below `minStep`
or time that cannot advance in double precision (`FAILED_TO_ADVANCE`), and an
exhausted budget (`MAX_STEPS_EXCEEDED`).

**Limitations.** This is an explicit non-stiff method: a stiff system makes
the controller shrink the step until it fails, which is reported rather than
hidden. Very long horizons at a coarse tolerance spend steps on accuracy they
do not need. Mass-balance accuracy is bounded by the tolerance derivation
above; the residual is reported with every result so the run can be audited.

### 8.3 Events

Input events are `iv-bolus` (instantaneous amount jump), `infusion-start`
(rate + infusion id) and `infusion-stop` (infusion id). Ordering is total and
documented (ADR-24): at one time, stops → boluses → starts, and within a
phase by `eventId` code point. An infusion id may open a new session after a
stop; a stop must close a strictly earlier start; zero-length intervals,
missing starts, unstopped sessions and duplicate ids are
`INVALID_EVENT_SEQUENCE`.

**Output semantics.** Each event time yields a `pre-event` sample and a
`post-event` sample at the same `time`, each tagged with its `eventGroup`.
`eventTrace` keeps one entry per event with `before`/`after` at full
precision. A chart adapter must draw the jump between the two sides and must
not reorder or merge them. Output times only request observations: they never
create, move or suppress an event, and changing the grid does not change the
event trace.

**Repeated and mixed regimens.** The editor may attach an optional repeat
count and interval to a bolus or infusion row; a single pure `expandEventRows`
expands the rows into this same flat event list before integration (ADR-29).
The engine never sees the repeat syntax — only the expanded events — so a
repeated bolus is the same instantaneous jump and a repeated infusion the same
zero-order input as a single dose, and the same ordering and mass-balance
rules apply unchanged.

### 8.4 Units at the boundary

`V_c`, `V_p` accept mass-free volume units (L, mL); `CL`, `Q` accept
clearance units (L/h, mL/h, mL/min); bolus amounts accept mass (mg, g, µg);
infusion rates accept mass-flow units (mg/h, µg/h, µg/min, g/h). Conversion
happens exactly once, at the boundary, and the report keeps both the declared
value/unit and the canonical value, plus a `UNITS_CONVERTED` warning when
they differ. Clearance (L/h), mass-flow (mg/h), mass and volume are distinct
dimensions; molar concentration is never derived from a mass concentration
without a molecular weight.

### 8.5 The report

`SimulationReport` is `{ ok: true, result } | { ok: false, model, errors }`.
A success carries the model id/version, equations and assumptions, the
scenario as supplied, the reference initial state, normalized parameters,
every sample (amounts, concentrations, cumulative input/elimination,
full-precision residual, side and event group), infusion-rate steps, the
event trace, solver diagnostics (method, settings, controller, accepted and
rejected steps, evaluations, step extremes, max error norm), the mass-balance
summary, and warnings. Failures carry typed errors with a stage
(`scenario`, `units`, `events`, `solver`, `model`, `invariants`), field and
event id when applicable.

### 8.6 Worked example (synthetic test parameters)

All numbers below are **synthetic test parameters**, not a real compound, not
a validated clinical estimate:

```
V_c = 10 L, V_p = 20 L, CL = 2 L/h, Q = 0 L/h
initial: A_c(0) = 100 mg, A_p(0) = 0 mg     horizon 0–24 h, output every hour
events: IV bolus 50 mg (mg) at t = 2 h
solver: atol = rtol = 1e-10, h0 = 0.01 h, h_min = 1e-12 h, h_max = 0.25 h
```

Closed form for Q = 0, CL/V_c = 0.2 h⁻¹: `A_c(t) = 100·e^(−0.2t)` before the
bolus and `A_c(t) = (100·e^(−0.4) + 50)·e^(−0.2(t−2))` after it;
`A_e(t) = 100·(1 − e^(−0.2t)) + 50·(1 − e^(−0.2(t−2)))`. The pre/post pair at
t = 2 reads 67.03 / 117.03 mg central with 0 / 50 mg cumulative input, and
`A_c + A_p + A_e − 100 − A_in ≈ 0` within ~1e-13 mg.

---

## 9. From `SimulationReport` to charts (phase 42)

The chart layer never calculates. `src/components/charts/simulationAdapter.ts`
is a pure function of the engine's `SimulationResult`: it copies
`SimulationSample` fields into traces and adds labels, units and hover
text. It imports no solver, calls no `simulate()`, and never derives a
concentration from an amount, an integral from samples, or a missing value
from a neighbour.

**Two charts, one dimension each.** Concentration (`mg/L`) and amount
(`mg`) are different physical dimensions and are never plotted on one
y-axis. `concentrationChart()` yields the central and peripheral
concentrations; `amountChart()` yields the compartment amounts plus the
cumulative-input and cumulative-eliminated accounting states (named as
accounting, because they carry the initial condition's history).

**Equal-time samples are preserved.** At a dosing event the engine emits a
`pre-event` and a `post-event` sample with the same time. The adapter keeps
both, in emission order, so the line trace contains a vertical segment at
the event time: after a bolus of D the central amount rises by exactly D
and the central concentration by D/V_c. No sorting, grouping, `Set`,
deduplication, resampling or interpolation is applied anywhere on this path.
Per-point hover text carries the sample side and the event group, so both
sides of the jump remain distinguishable, and `discontinuityIndices()`
exposes the pre→post positions for tests and annotations.

**Events and diagnostics come from the report.** Event rows are built from
`eventTrace` (never inferred from curve shape), and the diagnostics panel
shows the solver method, tolerances, accepted/rejected steps, derivative
evaluations, the mass-balance residual against its derived tolerance, the
canonical parameters, warnings, equations and assumptions.

**No plausible-looking failure.** A failed report, an empty sample set, a
non-finite value or a failed mass-balance check returns
`{ ok: false, reason }` from `buildSimulationCharts()`; the page shows that
reason as an error and draws nothing.

**Boundary summary.** Engine: physics and numerics. Adapter: presentation
mapping, total and pure. React/Plotly: layout and interaction only. A
completed run is reported as *numerically complete within the configured
tolerances*, never as scientifically validated (ADR-26).

---

## 10. Building a scenario from a form (phase 43)

The engine contract is unchanged; what changed is how a scenario is
produced. `src/features/simulation/draft.ts` holds a **string draft** and
compiles it with `compileScenario()` into the exact `SimulationScenario`
`simulate()` expects:

- every numeric field is parsed once — a blank field is an error, never 0;
- quantities keep the unit the user selected (the engine performs the
  canonical conversion at its boundary and reports the conversion);
- initial amounts are plain canonical mg, as `InitialState` defines;
- `outputTimes` comes from `buildOutputGrid(start, end, interval)`, which
  uses integer indices, includes the exact endpoints once, keeps times
  strictly ascending, and refuses a grid above `MAX_OUTPUT_SAMPLES`;
- each infusion row becomes an `infusion-start`/`infusion-stop` pair sharing
  an `infusionId`, with deterministic ids derived from the row key.

`simulate()` remains the sole scientific authority: positivity, units,
event sequencing against the horizon, solver rules and invariants are its
decisions, surfaced as typed errors with `stage`, `field` and `eventId`.
The compiler's own errors are limited to what text parsing can decide,
and the UI shows the two channels separately.

The reports that reach the charts are unchanged, so the chart semantics of
§9 (verbatim samples, preserved pre/post pairs, separate dimensions) hold
for edited scenarios exactly as for the example. The infusion-rate chart
uses `result.infusionRates` — the engine's summed pre/post snapshots — and
is absent when the scenario never activated an infusion.

## 11. Effect-site equilibration and occupancy (phase 46) — optional

Every input is supplied explicitly by the user; nothing is defaulted, and
Ki/IC50/EC50 are never substituted for K_d.

**Effect site.** dC_e/dt = k_e0·(f_u·C_c − C_e), where f_u is the stated
unbound fraction and C_c the central concentration the PK engine already
emitted. Between two emitted samples the unbound concentration is
reconstructed as piecewise linear and the ODE is propagated exactly over that
reconstruction:

    C_e1 = C_e0·e^(−x) + u0·(r − φ) + u1·φ
    x = k_e0·h,  r = −expm1(−x),  φ = 1 − r/x

φ is evaluated by a Horner series below x = 1e-2, where the direct quotient
loses precision; the threshold was chosen from measured error, not intuition.
h = 0 (a bolus's pre-event/post-event pair) keeps C_e unchanged.

**Occupancy.** C_e/(C_e + K_d), a single-site equilibrium binding ratio in
[0, 1). K_d must be a concentration compatible with the model concentration; a
molar K_d requires an explicit molecular weight (g/mol) with provenance.

**Initial condition and events.** C_e(startTime) = f_u·C_c(startTime,
pre-event), so a bolus at the start changes C_c but never jumps C_e or
occupancy, and the next interval propagates from the post-event concentration.
C_e is a derived variable excluded from physical drug-mass accounting.

**Measured convergence (one-compartment limit, Q = 0, CL = 2 L/h, Vc = 10 L, no
start event).** Worst error against the independent analytical solution falls
1.218e-2, 3.132e-3, 7.890e-4, 1.976e-4 and 4.943e-5 mg/L at output intervals
1, 0.5, 0.25, 0.125 and 0.0625 h — a ratio of about 4.0 per halving, i.e.
second order, as the piecewise-linear reconstruction predicts. This bound is
measured for that configuration only and is NOT claimed for every
two-compartment trajectory. The method is exact for the reconstruction, not for
the unknown continuous PK trajectory, and is not jointly integrated ODE
solving.
