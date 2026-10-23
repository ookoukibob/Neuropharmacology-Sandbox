# Third-party notices and source-reuse record

This file records the provenance of external code, algorithms and data that
were studied or reused while building Neuropharmacology Sandbox, and the
licensing decision behind each. It exists so that reuse is deliberate,
attributable and compliant.

## Noncompartmental analysis (NCA)

### Reference studied: PKNCA

- Project: PKNCA — https://github.com/humanpred/pknca
- Documentation: https://pknca.humanpredictions.com/
- License: **GNU Affero General Public License v3.0 (AGPL-3.0)** (verified from
  the repository's `LICENSE.md` and its GitHub `spdx_id`).
- Decision: **No source code was copied or adapted.** The NCA definitions
  implemented in `src/domain/experiments/nca.ts` — linear trapezoidal
  integration, the linear-up/log-down trapezoid, and log-linear regression of
  the terminal phase — are standard, textbook pharmacokinetic definitions. They
  were implemented independently from the published literature, not from
  PKNCA's source expression.

Why no reuse: this repository is distributed under the PolyForm Noncommercial
License 1.0.0, which restricts use to noncommercial purposes. AGPL-3.0 is a
strong copyleft license whose section 10 prohibits imposing further
restrictions on the exercise of the rights it grants. Combining PKNCA source
into this repository would require the combined work to be distributed under
AGPL-3.0, and could not also carry the PolyForm Noncommercial restriction
without conflicting with AGPL's terms. Resolving that conflict would require a
repository-wide license change, which the project has not authorized. This is a
technical reading of the two license texts, not legal advice.

### Alternative permissive implementations considered

- PyNCA (https://github.com/jsgraydon/PyNCA, MIT License) exists but is an
  early-stage, GUI/CLI-oriented package with minimal algorithm documentation;
  it was not a mature basis for porting.
- aNCA (https://github.com/pharmaverse/aNCA, Apache-2.0) is a Shiny wrapper
  whose core NCA estimators are delegated to PKNCA, so it does not offer an
  independently permissively-licensed NCA implementation.

No permissively-licensed, mature NCA implementation was identified as a source
to port, so the module was implemented from first principles against the
definitions below.

### Authoritative definitions the module follows

- Gabrielsson, J., & Weiner, D. (2012). *Pharmacokinetic and Pharmacodynamic
  Data Analysis: Concepts and Applications* (5th ed.). — trapezoidal AUC,
  linear-up/log-down integration, terminal half-life from the log-linear slope.
- Rowland, M., & Tozer, T. N. (2010). *Clinical Pharmacokinetics and
  Pharmacodynamics* (4th ed.). — Cmax/Tmax, AUC, clearance and volume of
  distribution definitions.
- Regulatory guidance on noncompartmental analysis (EMA and FDA bioequivalence
  guidance) — the terminal-phase extrapolation fraction as a quality concern.

These are cited as the scientific basis for the formulas; no text or code was
copied from them.

### Intentional differences from PKNCA

- PKNCA is data-frame/unit-aware and performs rule-based, automated
  terminal-phase selection and interval management. This module takes a
  user-selected, explicit terminal point count (default 3) and reports every
  excluded observation rather than applying PKNCA's automatic selection rules.
- Duplicate sampling times are not summarised: the module reports them as an
  ambiguity and requires resolution, rather than averaging replicates.
- Extrapolation to infinity is only produced when the last observation is the
  positive terminal-phase end; a trailing non-positive observation makes the
  extrapolated AUC unavailable, rather than silently back-filling.

## No other third-party source code incorporated

At the time of writing, no other third-party source files, fixtures or test
cases have been copied into this repository. All NCA fixtures are synthetic and
authored for this project.
