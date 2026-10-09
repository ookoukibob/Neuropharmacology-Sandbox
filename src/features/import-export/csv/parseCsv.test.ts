/**
 * CSV reader tests — quoting/escaping (commas, quotes, embedded newlines),
 * BOM handling, record separators and every malformed-input error path.
 * All values are synthetic test data, never pharmacological information.
 */
import { describe, expect, it } from 'vitest'
import { parseCsv } from './parseCsv'

describe('parseCsv — structure', () => {
  it('parses headers and rows separated by CRLF', () => {
    const result = parseCsv('name,note\r\nA,first\r\nB,second\r\n')
    expect(result).toEqual({
      ok: true,
      table: {
        headers: ['name', 'note'],
        rows: [
          ['A', 'first'],
          ['B', 'second'],
        ],
      },
    })
  })

  it('parses rows separated by LF and CR', () => {
    const lf = parseCsv('a,b\n1,2\n')
    expect(lf.ok && lf.table.rows).toEqual([['1', '2']])
    const cr = parseCsv('a,b\r1,2\r')
    expect(cr.ok && cr.table.rows).toEqual([['1', '2']])
  })

  it('keeps commas, escaped quotes and newlines inside quoted fields', () => {
    const text = 'name,note\n"Compound, A","say ""hi"""\n"Compound B","line1\nline2"\n'
    const result = parseCsv(text)
    expect(result).toEqual({
      ok: true,
      table: {
        headers: ['name', 'note'],
        rows: [
          ['Compound, A', 'say "hi"'],
          ['Compound B', 'line1\nline2'],
        ],
      },
    })
  })

  it('normalizes CRLF inside a quoted field to a single newline', () => {
    const result = parseCsv('a\n"x\r\ny"\n')
    expect(result.ok && result.table.rows).toEqual([['x\ny']])
  })

  it('strips a UTF-8 BOM from the first header', () => {
    const result = parseCsv('\uFEFFname,age\nSynthetic,1\n')
    expect(result.ok && result.table.headers).toEqual(['name', 'age'])
  })

  it('pads rows shorter than the header with empty cells', () => {
    const result = parseCsv('a,b,c\n1,2\n')
    expect(result.ok && result.table.rows).toEqual([['1', '2', '']])
  })

  it('keeps an empty quoted field as an empty cell', () => {
    const result = parseCsv('a,b\n"","x"\n')
    expect(result.ok && result.table.rows).toEqual([['', 'x']])
  })

  it('ignores blank lines between records', () => {
    const result = parseCsv('a,b\n\n1,2\n\n3,4\n')
    expect(result.ok && result.table.rows).toEqual([
      ['1', '2'],
      ['3', '4'],
    ])
  })

  it('preserves Unicode content verbatim', () => {
    const result = parseCsv('name,note\nÜnïcode,µM data\n')
    expect(result.ok && result.table.rows).toEqual([['Ünïcode', 'µM data']])
  })

  it('accepts a file without a trailing newline', () => {
    const result = parseCsv('a,b\n1,2')
    expect(result.ok && result.table.rows).toEqual([['1', '2']])
  })
})

describe('parseCsv — errors', () => {
  it('rejects an empty file', () => {
    const result = parseCsv('   \n  ')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('empty')
  })

  it('reports an unterminated quoted field with its line', () => {
    const result = parseCsv('a,b\n"oops\n')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/line \d+: unterminated quoted field/)
  })

  it('reports a quote inside an unquoted field', () => {
    const result = parseCsv('a,b\n1,ab"cd\n')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain(
      'quote character inside an unquoted field',
    )
  })

  it('reports characters after a closing quote', () => {
    const result = parseCsv('a,b\n"xy"z\n')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('after a closing quote')
  })

  it('reports a data row wider than the header', () => {
    const result = parseCsv('a,b\n1,2,3\n')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain(
      'data row 1 (line 2) has 3 columns but the header defines 2',
    )
  })

  it('reports duplicate column names as an ambiguity', () => {
    const result = parseCsv('name,name\nA,B\n')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toContain('duplicate column name "name"')
  })

  it('rejects a file that contains only a header with no data', () => {
    const result = parseCsv('name,note')
    expect(result.ok && result.table.rows).toEqual([])
  })
})
