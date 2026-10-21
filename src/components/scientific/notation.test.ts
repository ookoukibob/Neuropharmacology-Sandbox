import { describe, expect, it } from 'vitest'
import type { NotationToken } from './notation'
import { parseChemicalFormula, parseMathNotation } from './notation'

/** Compact assertion form so the expected rendering stays readable. */
function markup(tokens: readonly NotationToken[]): string {
  return tokens
    .map((token) =>
      token.kind === 'text' ? token.value : `<${token.kind}>${token.value}</${token.kind}>`,
    )
    .join('')
}

const math = (value: string): string => markup(parseMathNotation(value))
const chemical = (value: string): string => markup(parseChemicalFormula(value))

describe('parseMathNotation', () => {
  it('renders explicit letter and alphanumeric subscripts', () => {
    expect(math('K_d')).toBe('K<sub>d</sub>')
    expect(math('k_e0')).toBe('k<sub>e0</sub>')
    expect(math('f_u')).toBe('f<sub>u</sub>')
    expect(math('A_c(0)')).toBe('A<sub>c</sub>(0)')
    expect(math('dC_e/dt')).toBe('dC<sub>e</sub>/dt')
    expect(math('R_in(t)')).toBe('R<sub>in</sub>(t)')
  })

  it('renders known symbols with letter and numeric indices', () => {
    expect(math('EC50')).toBe('EC<sub>50</sub>')
    expect(math('IC50')).toBe('IC<sub>50</sub>')
    expect(math('Emax')).toBe('E<sub>max</sub>')
    expect(math('E0')).toBe('E<sub>0</sub>')
    expect(math('C0')).toBe('C<sub>0</sub>')
    expect(math('Kd')).toBe('K<sub>d</sub>')
    expect(math('Ki')).toBe('K<sub>i</sub>')
    expect(math('Vd')).toBe('V<sub>d</sub>')
  })

  it('keeps subscripts and exponents distinct', () => {
    expect(math('[D]^n')).toBe('[D]<sup>n</sup>')
    expect(math('e^(−k·t)')).toBe('e<sup>(−k·t)</sup>')
    expect(math('EC50^n')).toBe('EC<sub>50</sub><sup>n</sup>')
    expect(math('(EC50/[D])^n')).toBe('(EC<sub>50</sub>/[D])<sup>n</sup>')
    expect(math('x^-1')).toBe('x<sup>-1</sup>')
    expect(math('x^2.5')).toBe('x<sup>2.5</sup>')
  })

  it('renders the complete Hill/Emax formula without changing its meaning', () => {
    expect(math('E = E0 + (Emax · [D]^n) / (EC50^n + [D]^n)')).toBe(
      'E = E<sub>0</sub> + (E<sub>max</sub> · [D]<sup>n</sup>) / ' +
        '(EC<sub>50</sub><sup>n</sup> + [D]<sup>n</sup>)',
    )
  })

  it('renders the PK and occupancy formulas used by the engine', () => {
    expect(math('C(t) = C0 · e^(−k·t),  where k = ln(2) / t½')).toBe(
      'C(t) = C<sub>0</sub> · e<sup>(−k·t)</sup>,  where k = ln(2) / t½',
    )
    expect(math('Occupancy = [D] / ([D] + Kd)')).toBe(
      'Occupancy = [D] / ([D] + K<sub>d</sub>)',
    )
    expect(math('Mass balance (A_c + A_p + A_e − A_ref − A_in)')).toBe(
      'Mass balance (A<sub>c</sub> + A<sub>p</sub> + A<sub>e</sub> − ' +
        'A<sub>ref</sub> − A<sub>in</sub>)',
    )
  })

  it('preserves punctuation, Greek letters, minus signs, dots and spacing', () => {
    expect(math('t½ = ln(2) / k')).toBe('t½ = ln(2) / k')
    expect(math('− Δ · ± ≤ ≥')).toBe('− Δ · ± ≤ ≥')
    expect(math('K_d → nM')).toBe('K<sub>d</sub> → nM')
  })

  it('leaves ordinary text, drug names and arbitrary identifiers unchanged', () => {
    for (const value of [
      'Synthetic Fixture Compound',
      'Midazolam',
      'dexmedetomidine',
      'drug_name',
      'snake_case',
      'sample_id',
      'COVID19',
      'C12H14N2O',
      'Emaximal',
      'xEC50',
      'EC50x',
      '1E0',
    ]) {
      expect(math(value)).toBe(value)
    }
  })

  it('fails safely on empty or malformed notation', () => {
    expect(parseMathNotation('')).toEqual([])
    for (const value of ['K_', '[D]^', 'e^(−k·t', '^n', 'x ^n', 'K_^']) {
      expect(math(value)).toBe(value)
    }
  })
})

describe('parseChemicalFormula', () => {
  it('renders element counts as subscripts', () => {
    expect(chemical('C12H14N2O')).toBe('C<sub>12</sub>H<sub>14</sub>N<sub>2</sub>O')
    expect(chemical('C6H8O7')).toBe('C<sub>6</sub>H<sub>8</sub>O<sub>7</sub>')
    expect(chemical('C12H14N2O4S')).toBe(
      'C<sub>12</sub>H<sub>14</sub>N<sub>2</sub>O<sub>4</sub>S',
    )
  })

  it('preserves multi-letter elements, groups and separators', () => {
    expect(chemical('NaCl')).toBe('NaCl')
    expect(chemical('C12H14N2O·HCl')).toBe(
      'C<sub>12</sub>H<sub>14</sub>N<sub>2</sub>O·HCl',
    )
    expect(chemical('C12H14N2O.HCl')).toBe(
      'C<sub>12</sub>H<sub>14</sub>N<sub>2</sub>O.HCl',
    )
    expect(chemical('(CH3)2NH')).toBe('(CH<sub>3</sub>)<sub>2</sub>NH')
    expect(chemical('2H2O')).toBe('2H<sub>2</sub>O')
    expect(chemical('C12H14N2O+')).toBe('C<sub>12</sub>H<sub>14</sub>N<sub>2</sub>O+')
  })

  it('leaves values that are not molecular formulas completely unchanged', () => {
    for (const value of [
      '',
      'not a formula',
      'COVID19',
      'Xx12',
      'c12h14n2o',
      'K_d',
      'Synthetic Fixture Compound',
    ]) {
      expect(chemical(value)).toBe(value)
    }
  })

  it('preserves surrounding whitespace', () => {
    expect(chemical(' C12H14N2O ')).toBe(' C<sub>12</sub>H<sub>14</sub>N<sub>2</sub>O ')
  })
})
