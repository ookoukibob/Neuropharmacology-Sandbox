/**
 * Focused RFC 4180 CSV reader for the import/export feature.
 *
 * Scope is deliberately small — one delimiter, one quote character, no
 * dependency: quoted fields (escaped `""`, commas and line breaks inside
 * quotes), CR/LF/CRLF record separators, an optional UTF-8 BOM. Everything
 * else fails with an actionable message naming the line, because a file we
 * cannot parse unambiguously must never be silently guessed at.
 *
 * Structural checks performed here (layer 1 of docs/validation.md):
 * - unterminated quoted field, quote after closing quote, quote inside an
 *   unquoted field → parse error;
 * - data rows wider than the header → error (an extra value cannot be
 *   assigned to a column safely); rows narrower than the header are padded
 *   with empty cells (visible as empty in the mapping preview);
 * - duplicate column names → error (mapping would be ambiguous);
 * - blank lines between records are ignored.
 *
 * Field *meaning* is never inferred: headers are returned verbatim and the
 * user maps every column explicitly.
 */

export interface CsvTable {
  readonly headers: readonly string[]
  /** Data rows, padded/truncated to the header width. */
  readonly rows: readonly (readonly string[])[]
}

export type CsvParseResult =
  | { readonly ok: true; readonly table: CsvTable }
  | { readonly ok: false; readonly error: string }

interface RawRecord {
  readonly fields: readonly string[]
  /** 1-based line where the record started (for error messages). */
  readonly line: number
}

interface Accumulator {
  readonly records: RawRecord[]
}

/** Parse CSV text into headers + data rows, or an actionable error. */
export function parseCsv(text: string): CsvParseResult {
  const input = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (input.trim() === '') {
    return { ok: false, error: 'the file is empty — expected a header row followed by data rows' }
  }

  const acc: Accumulator = { records: [] }
  let fields: string[] = []
  let field = ''
  let inQuotes = false
  let afterQuote = false
  let line = 1
  let recordLine = 1
  let started = false

  const pushField = (): void => {
    fields.push(field)
    field = ''
    afterQuote = false
  }
  const pushRecord = (): void => {
    pushField()
    acc.records.push({ fields, line: recordLine })
    fields = []
    started = false
  }

  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charAt(i)

    if (inQuotes) {
      if (ch === '"') {
        if (input.charAt(i + 1) === '"') {
          field += '"'
          i += 1
          continue
        }
        inQuotes = false
        afterQuote = true
        continue
      }
      if (ch === '\r') {
        if (input.charAt(i + 1) === '\n') i += 1
        field += '\n'
        line += 1
        continue
      }
      if (ch === '\n') {
        field += '\n'
        line += 1
        continue
      }
      field += ch
      continue
    }

    if (afterQuote) {
      if (ch === ',') {
        pushField()
        started = true
        continue
      }
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && input.charAt(i + 1) === '\n') i += 1
        line += 1
        pushRecord()
        recordLine = line
        continue
      }
      return {
        ok: false,
        error: `line ${line}: unexpected character ${JSON.stringify(ch)} after a closing quote — remove it or wrap the whole value in quotes`,
      }
    }

    if (ch === '"') {
      if (field === '') {
        inQuotes = true
        continue
      }
      return {
        ok: false,
        error: `line ${line}: quote character inside an unquoted field — wrap the whole value in double quotes`,
      }
    }
    if (ch === ',') {
      pushField()
      started = true
      continue
    }
    if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input.charAt(i + 1) === '\n') i += 1
      line += 1
      pushRecord()
      recordLine = line
      continue
    }
    field += ch
    started = true
  }

  if (inQuotes) {
    return {
      ok: false,
      error: `line ${recordLine}: unterminated quoted field — the file ends before its closing quote`,
    }
  }
  // Flush a final record that was not terminated by a newline.
  if (started || field !== '' || fields.length > 0 || afterQuote) pushRecord()

  // Drop blank-line records produced between records.
  const records = acc.records.filter(
    (r) => !(r.fields.length === 1 && r.fields[0] === ''),
  )
  const header = records[0]
  if (header === undefined) {
    return { ok: false, error: 'the file has no header row' }
  }

  const seen = new Set<string>()
  for (const name of header.fields) {
    if (name === '') continue
    if (seen.has(name)) {
      return {
        ok: false,
        error: `duplicate column name ${JSON.stringify(name)} (line ${header.line}) — column names must be unique so every column can be mapped unambiguously`,
      }
    }
    seen.add(name)
  }

  const width = header.fields.length
  const rows: string[][] = []
  for (let r = 1; r < records.length; r += 1) {
    const record = records[r]!
    const dataRow = r // 1-based data row index (header is row 0)
    if (record.fields.length > width) {
      return {
        ok: false,
        error: `data row ${dataRow} (line ${record.line}) has ${record.fields.length} columns but the header defines ${width} — fix the row or add the missing column name`,
      }
    }
    const padded = record.fields.slice()
    while (padded.length < width) padded.push('')
    rows.push(padded)
  }

  return { ok: true, table: { headers: header.fields, rows } }
}
