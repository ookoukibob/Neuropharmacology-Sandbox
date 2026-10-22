import { describe, expect, it } from 'vitest'
import {
  NOTATION_BASES,
  findRawNotation,
  isNotationTargetFile,
  notationReportMessage,
} from './detect.mjs'

/**
 * Unit tests for the detection decisions. The rule's AST wiring is proved
 * separately, by linting real files in `rule.test.mjs`.
 */
const found = (text) => findRawNotation(text).map((hit) => hit.text)

describe('findRawNotation — rejects visible notation', () => {
  it('finds underscore subscripts used by this application', () => {
    expect(found('V_c')).toEqual(['V_c'])
    expect(found('V_p')).toEqual(['V_p'])
    expect(found('A_c(0)')).toEqual(['A_c'])
    expect(found('A_p(0)')).toEqual(['A_p'])
    expect(found('Reference time t_ref')).toEqual(['t_ref'])
    expect(found('Equilibration rate k_e0')).toEqual(['k_e0'])
    expect(found('K_d in mg/L')).toEqual(['K_d'])
    expect(found('Mass balance (A_c + A_p + A_e − A_ref − A_in)')).toEqual([
      'A_c',
      'A_p',
      'A_e',
      'A_ref',
      'A_in',
    ])
  })

  it('finds the derivative prefix form', () => {
    expect(found('dC_e/dt')).toEqual(['C_e'])
  })

  it('separates consecutive symbols without swallowing their neighbours', () => {
    expect(found('V_c V_p')).toEqual(['V_c', 'V_p'])
    expect(found('A_c, A_p')).toEqual(['A_c', 'A_p'])
  })

  it('finds caret exponents', () => {
    expect(found('[D]^n')).toEqual(['^n'])
    expect(found('EC50^n over (EC50^n + [D]^n)')).toEqual(['^n', '^n', '^n'])
  })

  it('reports a caret only when it is actually an exponent', () => {
    expect(found('press ^ then space')).toEqual([])
    expect(found(' a^ b')).toEqual([])
  })
})

describe('findRawNotation — accepts everything else', () => {
  it('leaves ordinary identifiers, constants and CSS alone', () => {
    for (const text of [
      'snake_case',
      'drug_name',
      'sample_id',
      'PK_KEYS',
      'NO_ERRORS',
      'NO_MEASUREMENTS',
      'LN_TWO',
      'mw_freebase',
      'in_oklch',
      'C12H14N2O',
      'COVID19',
      'Midazolam is a synthetic fixture',
      'Molecular-weight provenance',
      'Residual degrees of freedom (n − 2)',
      '',
    ]) {
      expect(found(text), text).toEqual([])
    }
  })

  it('does not treat an uppercase run as a subscript base', () => {
    // `PK_KEYS` has K next to _, but the letter before it is part of a word,
    // so only a symbol that starts a token is notation.
    expect(found('PK_KEYS')).toEqual([])
    expect(found('MAX_ROWS')).toEqual([])
  })
})

describe('isNotationTargetFile', () => {
  it('covers application source on any platform path style', () => {
    expect(isNotationTargetFile('D:/repo/src/features/simulation/ScenarioSections.tsx')).toBe(true)
    expect(isNotationTargetFile('src/components/charts/simulationAdapter.ts')).toBe(true)
    expect(isNotationTargetFile('src/domain/experiments/fit.ts')).toBe(true)
  })

  it('exempts the renderer, tests, fixtures and non-source files', () => {
    for (const file of [
      'src/components/scientific/notation.ts',
      'src/components/scientific/ParameterLabel.test.tsx',
      'src/features/simulation/draft.test.ts',
      'src/tests/fixtures/sources/x.ts',
      'e2e/scientificNotation.spec.ts',
      'scripts/notation-lint/plugin.mjs',
      'docs/architecture.md',
      '',
    ]) {
      expect(isNotationTargetFile(file), file).toBe(false)
    }
  })
})

describe('notationReportMessage', () => {
  it('names the fix, not just the fault', () => {
    const [hit] = findRawNotation('V_c')
    const message = notationReportMessage(hit)
    expect(message).toContain('"V_c"')
    expect(message).toContain('<ScientificText value="V_c" />')
    expect(message).toContain('parameterFields.ts')
    expect(message).toContain('<ParameterLabel />')
    expect(message).toContain('oxlint-disable-next-line notation/no-raw-scientific-notation')
  })
})

describe('base allowlist', () => {
  it('stays deliberately small', () => {
    expect(NOTATION_BASES).toEqual(['A', 'C', 'E', 'K', 'R', 'V', 'f', 'k', 't'])
  })
})
