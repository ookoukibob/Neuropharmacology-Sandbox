/**
 * CSV writer tests — RFC 4180 escaping and a parse round trip proving the
 * writer's output is readable by the reader with identical content.
 */
import { describe, expect, it } from 'vitest'
import { escapeCsvField, toCsv } from './writeCsv'
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
