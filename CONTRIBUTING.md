# Contributing

Thanks for taking an interest in Neuropharmacology Sandbox.

## Scope and scientific principles

This project is a transparent, local-first mathematical modelling tool. It is
not a clinical decision-support system or a source of medical advice.

Contributions should preserve these principles:

- Never invent, silently default or silently substitute a scientific parameter.
- Keep units, assumptions, intermediate calculations, warnings and provenance
  visible where they affect a result.
- Keep pharmacological formulas and unit conversion rules out of presentation
  components; put scientific behavior in typed, testable engine code.
- Treat imported files and browser-stored records as untrusted input.
- Preserve historical file compatibility deliberately. Changes to `.npsl`,
  `.npsb`, or IndexedDB schemas need migration/round-trip tests and clear
  documentation of any fidelity boundary.
- Label synthetic examples explicitly. A mathematically consistent result is
  not by itself empirical validation or a clinical conclusion.

## Development setup

Requirements: Node.js 22 or newer and npm.

```bash
npm ci
npx playwright install chromium
npm run dev
```

Useful verification commands:

```bash
npm run typecheck
npm run typecheck:e2e
npm run lint
npm test
npm run test:coverage
npm run build
npm run test:e2e
npm run test:crash
npm audit --omit=dev
git diff --check
```

The Playwright end-to-end and crash-durability suites require Chromium. The
optional `npm run smoke:chembl` script performs a live external-service smoke
test; it is not part of the normal offline test suite and should only be run
intentionally.

## Pull requests

- Keep changes focused and explain the problem, intended behavior and evidence.
- Add regression tests for bug fixes and tests for new formulas, unit conversions,
  parameter validation, edge cases and error paths.
- For UI changes, preserve keyboard operation, accessible names and visible
  error recovery; update E2E coverage where appropriate.
- For data or format changes, document compatibility behavior and test both new
  and older records/archives.
- Do not commit generated build output, test artifacts, local environment files,
  credentials or local agent/editor settings.
- Do not change the release version or publish tags in ordinary feature PRs.
  Release preparation must update the version fields, changelog and release
  documentation together.

## License

The repository uses the PolyForm Noncommercial License 1.0.0. Contributions
are subject to that license; opening a pull request does not grant commercial
use rights. See [LICENSE](LICENSE) before contributing.
