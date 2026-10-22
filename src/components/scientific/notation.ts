/**
 * Presentation-only notation rules for scientific symbols and formulas.
 *
 * The renderer is deliberately small and is only ever given trusted,
 * application-authored strings (engine labels, model formulas, trace
 * expressions and source-data molecular formulas). It never receives drug
 * names, descriptions, notes, source attribution, user input or free text.
 *
 * Two modes are kept separate:
 *
 *  - `math` understands the subset of notation this application writes:
 *      explicit subscripts (`K_d`, `k_e0`, `A_c(0)`),
 *      a small set of implicit symbols (`EC50`, `Emax`, `C0`, `Kd`, ...),
 *      and caret exponents (`[D]^n`, `e^(−k·t)`).
 *    Greek letters, `t½`, minus signs, multiplication dots, punctuation and
 *    spacing are preserved literally.
 *
 *  - `chemical` formats a value that is known to be a molecular formula
 *    (`C12H14N2O` -> C<sub>12</sub>H<sub>14</sub>N<sub>2</sub>O). The parser
 *    validates the whole value first and returns it unchanged if it is not a
 *    formula, so an arbitrary alphanumeric string can never be half-formatted.
 *
 * Parsing returns structured tokens. No HTML is generated or injected; the
 * React layer renders native <sub>/<sup> elements.
 */

export type NotationMode = 'math' | 'chemical'

export type NotationToken =
  | { readonly kind: 'text'; readonly value: string }
  | { readonly kind: 'sub'; readonly value: string }
  | { readonly kind: 'sup'; readonly value: string }

interface ImplicitSubscript {
  readonly symbol: string
  readonly base: string
  readonly subscript: string
}

/**
 * Symbols whose index is part of the conventional name rather than marked by
 * an underscore. Longest symbols come first; matching also requires token
 * boundaries so `Emax` inside a longer word is left alone.
 */
const IMPLICIT_SUBSCRIPTS: readonly ImplicitSubscript[] = [
  { symbol: 'EC50', base: 'EC', subscript: '50' },
  { symbol: 'IC50', base: 'IC', subscript: '50' },
  { symbol: 'Emax', base: 'E', subscript: 'max' },
  { symbol: 'E0', base: 'E', subscript: '0' },
  { symbol: 'C0', base: 'C', subscript: '0' },
  { symbol: 'Kd', base: 'K', subscript: 'd' },
  { symbol: 'Ki', base: 'K', subscript: 'i' },
  { symbol: 'Vd', base: 'V', subscript: 'd' },
]

/**
 * Base symbols this application writes with an underscore subscript. A
 * generic `letter_letter` rule would reinterpret ordinary identifiers such as
 * `snake_case`, so the set is explicit and narrowly scoped.
 */
const UNDERSCORE_BASES = new Set(['A', 'C', 'E', 'K', 'R', 'V', 'f', 'k', 't'])

const WORD_CHAR = /[A-Za-z0-9_]/

const isWordChar = (value: string): boolean => value !== '' && WORD_CHAR.test(value)

const isAsciiLetterOrDigit = (value: string): boolean => /[A-Za-z0-9]/.test(value)

const textToken = (value: string): NotationToken => ({ kind: 'text', value })

const subToken = (value: string): NotationToken => ({ kind: 'sub', value })

/** Match one of the conventional implicit-index symbols at `index`. */
function matchImplicitSubscript(
  input: string,
  index: number,
): (ImplicitSubscript & { readonly end: number }) | undefined {
  for (const rule of IMPLICIT_SUBSCRIPTS) {
    if (!input.startsWith(rule.symbol, index)) continue
    const before = index > 0 ? input.charAt(index - 1) : ''
    const after = input.charAt(index + rule.symbol.length)
    if (isWordChar(before) || isWordChar(after)) continue
    return { ...rule, end: index + rule.symbol.length }
  }
  return undefined
}

/** Match an explicit `X_subscript` sequence (never a generic identifier). */
function matchUnderscoreSubscript(
  input: string,
  index: number,
): { readonly base: string; readonly subscript: string; readonly end: number } | undefined {
  const base = input.charAt(index)
  if (!UNDERSCORE_BASES.has(base) || input.charAt(index + 1) !== '_') return undefined

  const before = index > 0 ? input.charAt(index - 1) : ''
  // Upper-case bases may follow the differential operator (`dC_e/dt`); lower-
  // case bases must start a token so embedded identifiers stay untouched.
  if (base === base.toLowerCase() && isWordChar(before)) return undefined
  if (before === '_') return undefined

  let end = index + 2
  while (end < input.length && isAsciiLetterOrDigit(input.charAt(end))) end += 1
  if (end === index + 2) return undefined

  return { base, subscript: input.slice(index + 2, end), end }
}

/**
 * Match a caret exponent. A balanced parenthesised group or a numeric/name
 * run is accepted; anything else leaves the caret literal (safe failure).
 */
function matchSuperscript(
  input: string,
  index: number,
): { readonly value: string; readonly end: number } | undefined {
  if (input.charAt(index) !== '^' || index === 0) return undefined
  const before = input.charAt(index - 1)
  if (before === '^' || /\s/.test(before)) return undefined

  const start = index + 1
  if (input.charAt(start) === '(') {
    let depth = 0
    for (let cursor = start; cursor < input.length; cursor += 1) {
      const char = input.charAt(cursor)
      if (char === '(') depth += 1
      if (char === ')') {
        depth -= 1
        if (depth === 0) {
          return { value: input.slice(start, cursor + 1), end: cursor + 1 }
        }
      }
    }
    return undefined
  }

  const rest = input.slice(start)
  const numeric = /^[+−-]?\d+(?:\.\d+)?(?:[eE][+−-]?\d+)?/.exec(rest)?.at(0)
  if (numeric !== undefined) return { value: numeric, end: start + numeric.length }

  const identifier = /^[A-Za-z][A-Za-z0-9]*/.exec(rest)?.at(0)
  if (identifier !== undefined) return { value: identifier, end: start + identifier.length }

  return undefined
}

/** Tokenise mathematical/scientific notation, preserving everything else. */
export function parseMathNotation(input: string): readonly NotationToken[] {
  const tokens: NotationToken[] = []
  let pending = ''

  const flush = (): void => {
    if (pending !== '') {
      tokens.push(textToken(pending))
      pending = ''
    }
  }

  let index = 0
  while (index < input.length) {
    const implicit = matchImplicitSubscript(input, index)
    if (implicit !== undefined) {
      flush()
      tokens.push(textToken(implicit.base), subToken(implicit.subscript))
      index = implicit.end
      continue
    }

    const underscore = matchUnderscoreSubscript(input, index)
    if (underscore !== undefined) {
      flush()
      tokens.push(textToken(underscore.base), subToken(underscore.subscript))
      index = underscore.end
      continue
    }

    const superscript = matchSuperscript(input, index)
    if (superscript !== undefined) {
      flush()
      tokens.push({ kind: 'sup', value: superscript.value })
      index = superscript.end
      continue
    }

    pending += input.charAt(index)
    index += 1
  }

  flush()
  return tokens
}

/**
 * All element symbols. Chemical-mode formatting only accepts values built
 * from these symbols (plus counts, groups and common separators); a string
 * such as `COVID19` is returned unchanged rather than partially indexed.
 */
const ELEMENTS = new Set(
  (
    'H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn ' +
    'Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce ' +
    'Pr Nd Pm Sm Eu Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn ' +
    'Fr Ra Ac Th Pa U Np Pu Am Cm Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl ' +
    'Mc Lv Ts Og'
  ).split(' '),
)

interface ElementMatch {
  readonly symbol: string
  readonly next: number
}

interface DigitMatch {
  readonly value: string
  readonly next: number
}

function readElement(input: string, index: number): ElementMatch | undefined {
  const first = input.charAt(index)
  if (first < 'A' || first > 'Z') return undefined
  const second = input.charAt(index + 1)
  const symbol = second >= 'a' && second <= 'z' ? first + second : first
  if (!ELEMENTS.has(symbol)) return undefined
  return { symbol, next: index + symbol.length }
}

function readDigits(input: string, index: number): DigitMatch | undefined {
  let end = index
  while (end < input.length) {
    const code = input.charCodeAt(end)
    if (code < 48 || code > 57) break
    end += 1
  }
  return end === index ? undefined : { value: input.slice(index, end), next: end }
}

function readFormulaComponent(
  input: string,
  index: number,
  tokens: NotationToken[],
  depth: number,
): number | undefined {
  if (depth > 8) return undefined

  // A leading stoichiometric/hydrate coefficient (for example `2H2O`) is
  // ordinary text, not a subscript.
  let next = index
  const coefficient = readDigits(input, next)
  if (coefficient !== undefined) {
    tokens.push(textToken(coefficient.value))
    next = coefficient.next
  }

  if (input.charAt(next) === '(') {
    tokens.push(textToken('('))
    const inner = readFormulaSequence(input, next + 1, tokens, depth + 1)
    if (inner === undefined || input.charAt(inner) !== ')') return undefined
    tokens.push(textToken(')'))
    next = inner + 1
  } else {
    const element = readElement(input, next)
    if (element === undefined) return undefined
    tokens.push(textToken(element.symbol))
    next = element.next
  }

  const count = readDigits(input, next)
  if (count !== undefined) {
    tokens.push(subToken(count.value))
    next = count.next
  }
  return next
}

function readFormulaSequence(
  input: string,
  index: number,
  tokens: NotationToken[],
  depth: number,
): number | undefined {
  let next = readFormulaComponent(input, index, tokens, depth)
  if (next === undefined) return undefined

  while (next < input.length) {
    const char = input.charAt(next)
    if (char === ')') return next

    if (char === '·' || char === '.') {
      tokens.push(textToken(char))
      next += 1
      while (input.charAt(next) === ' ') {
        tokens.push(textToken(' '))
        next += 1
      }
      next = readFormulaComponent(input, next, tokens, depth)
      if (next === undefined) return undefined
      continue
    }

    if (char === ' ') {
      let probe = next
      while (input.charAt(probe) === ' ') {
        tokens.push(textToken(' '))
        probe += 1
      }
      if (probe >= input.length || input.charAt(probe) === ')') return probe
      next = readFormulaComponent(input, probe, tokens, depth)
      if (next === undefined) return undefined
      continue
    }

    if (char === '+' || char === '-' || char === '−') {
      tokens.push(textToken(char))
      return next + 1
    }

    next = readFormulaComponent(input, next, tokens, depth)
    if (next === undefined) return undefined
  }

  return next
}

/**
 * Tokenise a molecular formula. If any part of the value does not follow the
 * accepted formula grammar, the whole value is returned as one text token.
 */
export function parseChemicalFormula(input: string): readonly NotationToken[] {
  if (input === '') return []

  const tokens: NotationToken[] = []
  let index = 0
  while (input.charAt(index) === ' ') {
    tokens.push(textToken(' '))
    index += 1
  }

  const end = readFormulaSequence(input, index, tokens, 0)
  if (end === undefined) return [textToken(input)]

  let rest = end
  while (input.charAt(rest) === ' ') {
    tokens.push(textToken(' '))
    rest += 1
  }
  if (rest !== input.length) return [textToken(input)]

  return tokens
}

/** Parse a value using the selected presentation mode. */
export function parseNotation(value: string, mode: NotationMode): readonly NotationToken[] {
  return mode === 'chemical' ? parseChemicalFormula(value) : parseMathNotation(value)
}
