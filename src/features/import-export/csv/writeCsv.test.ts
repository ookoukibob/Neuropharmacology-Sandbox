/**
 * CSV writer tests — RFC 4180 escaping, the spreadsheet formula-injection
 * guard, and a parse round trip proving the writer's output is readable by
 * the reader with identical content.
 */
import { describe, expect, it } from 'vitest'
import { escapeCsvField, protectAgainstFormulaInjection, toCsv } from './writeCsv'
import { parseCsv } from './parseCsv'

describe('escapeCsvField', () => {
  it('leaves plain values untouched', () => {
    expect(escapeCsvField('nM')).toBe('nM')
    expect(escapeCsvField('4.2')).toBe('4.2')
  })

  it('quotes values containing a comma', () => {
    expect(escapeCsvField('a,b')).toBe('"a,b"')
  })

  it('doubles embedded quotes', () => {
    expect(escapeCsvField('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes values containing line breaks', () => {
    expect(escapeCsvField('line1\nline2')).toBe('"line1\nline2"')
    expect(escapeCsvField('line1\r\nline2')).toBe('"line1\r\nline2"')
  })

  it('quotes leading or trailing whitespace so it survives parsing', () => {
    expect(escapeCsvField(' padded ')).toBe('" padded "')
    expect(escapeCsvField('x ')).toBe('"x "')
  })
})

describe('protectAgainstFormulaInjection', () => {
  it('guards every OWASP trigger character at the start of a cell', () => {
    expect(protectAgainstFormulaInjection('=1+1')).toBe("'=1+1")
    expect(protectAgainstFormulaInjection('+SUM(A1:A9)')).toBe("'+SUM(A1:A9)")
    expect(protectAgainstFormulaInjection('-2+3')).toBe("'-2+3")
    expect(protectAgainstFormulaInjection('@SUM(1)')).toBe("'@SUM(1)")
    // A single trigger character is still a trigger.
    expect(protectAgainstFormulaInjection('=')).toBe("'=")
    expect(protectAgainstFormulaInjection('-')).toBe("'-")
  })

  it('guards triggers hiding behind leading whitespace or control characters', () => {
    expect(protectAgainstFormulaInjection(' =1+1')).toBe("' =1+1")
    expect(protectAgainstFormulaInjection('\t=cmd|calc')).toBe("'\t=cmd|calc")
    expect(protectAgainstFormulaInjection('\r\n=1+1')).toBe("'\r\n=1+1")
    expect(protectAgainstFormulaInjection('\u0000@x')).toBe("'\u0000@x")
    expect(protectAgainstFormulaInjection('  +SUM(1)')).toBe("'  +SUM(1)")
  })

  it('returns ordinary text byte-identically — no cosmetic apostrophes', () => {
    expect(protectAgainstFormulaInjection('Aspirin')).toBe('Aspirin')
    expect(protectAgainstFormulaInjection('Ünïcødé 化合物')).toBe('Ünïcødé 化合物')
    expect(protectAgainstFormulaInjection('a,b')).toBe('a,b')
    expect(protectAgainstFormulaInjection('say "hi"')).toBe('say "hi"')
    expect(protectAgainstFormulaInjection('line1\nline2')).toBe('line1\nline2')
    expect(protectAgainstFormulaInjection(' padded ')).toBe(' padded ')
    expect(protectAgainstFormulaInjection('')).toBe('')
    // Negative-looking prose without a leading trigger (mid-cell `-`/`=` is inert).
    expect(protectAgainstFormulaInjection('compound-2 next')).toBe('compound-2 next')
  })

  it('composes with quoting so a guarded cell is still structurally valid CSV', () => {
    // Guard first, then quote — the apostrophe sits outside any quoting and
    // also fixes the whitespace-trim edge (the cell now starts with `'`).
    const guarded = protectAgainstFormulaInjection(' =1+1,ok')
    expect(guarded).toBe("' =1+1,ok")
    expect(escapeCsvField(guarded)).toBe(`"' =1+1,ok"`)
    const text = toCsv(['name'], [[guarded]])
    expect(text).toBe(`name\r\n"' =1+1,ok"\r\n`)
    expect(parseCsv(text)).toEqual({
      ok: true,
      table: { headers: ['name'], rows: [["' =1+1,ok"]] },
    })
  })
})

describe('toCsv', () => {
  it('joins records with CRLF and ends with a record separator', () => {
    const text = toCsv(['a', 'b'], [['1', '2'], ['3', '4']])
    expect(text).toBe('a,b\r\n1,2\r\n3,4\r\n')
  })

  it('round trips through parseCsv with commas, quotes, newlines and Unicode', () => {
    const headers = ['name', 'note']
    const rows = [
      ['Compound, A', 'said "hi"'],
      ['Ünïcode', 'line1\nline2'],
      [' padded ', ''],
    ]
    const result = parseCsv(toCsv(headers, rows))
    expect(result).toEqual({ ok: true, table: { headers, rows } })
  })
})
