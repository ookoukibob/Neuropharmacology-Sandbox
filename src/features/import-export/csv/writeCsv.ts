/**
 * RFC 4180 CSV writer for the export side of the import/export feature.
 *
 * Every field is escaped — a value containing a delimiter, quote, line
 * break or edge whitespace is quoted and its quotes doubled. Nothing is
 * ever concatenated raw, so names, descriptions and provenance JSON can
 * contain commas, quotes and newlines without corrupting the file.
 *
 * Spreadsheet formula injection (CSV injection): RFC-4180 quoting alone
 * does not stop a spreadsheet from EXECUTING a text cell that begins with
 * `=`, `+`, `-` or `@` — nor one where leading whitespace or control
 * characters (which spreadsheets trim first) precede such a character.
 * The export therefore passes every *text* cell through
 * `protectAgainstFormulaInjection` BEFORE quoting: a dangerous cell gains
 * a leading apostrophe, which spreadsheet consumers treat as a text
 * marker, so the cell is kept as text instead of evaluated. Cells that do
 * not start with a dangerous character are returned unchanged — ordinary
 * exports are byte-identical to before this guard, and *numeric* cells
 * (finite numbers serialized with `String(value)`) bypass it entirely so
 * legitimate values such as `-2.5` keep their exact representation.
 *
 * This is a documented mitigation, not a proof: whether a consumer shows
 * or consumes the leading apostrophe, and how it normalizes the rest of
 * the cell, is tool-specific. The guard prevents formula evaluation in
 * common tools (Excel, LibreOffice, Google Sheets) but cannot make CSV an
 * executable-free interchange for every consumer. A CSV re-import keeps
 * the apostrophe verbatim — another reason CSV stays a lossy projection
 * and `.npsl`/`.json` remain the backup formats.
 *
 * Records are separated by CRLF and the file ends with a record
 * separator, as recommended by RFC 4180 and expected by spreadsheet
 * tools. Quote or not:
 *
 *   needsQuoting("a,b")   → '"a,b"'
 *   needsQuoting('say"')  → '"say"""'
 *   needsQuoting("x\ny")  → '"x\ny"'
 *
 * Formula guard (applied first, then quoting):
 *
 *   protectAgainstFormulaInjection('=1+1')    → "'=1+1"
 *   protectAgainstFormulaInjection(' =SUM(1)')→ "' =SUM(1)"
 *   protectAgainstFormulaInjection('Aspirin') → 'Aspirin'
 */

/**
 * Spreadsheet formula trigger characters documented by OWASP: `=`, `+`,
 * `-`, `@` (as char codes so the scan below needs no control-character
 * regex class).
 */
const FORMULA_TRIGGERS: ReadonlySet<number> = new Set([
  0x3d, // =
  0x2b, // +
  0x2d, // -
  0x40, // @
])

/**
 * Make a TEXT cell inert for spreadsheet consumers: prefix a single
 * apostrophe when the cell could be read as a formula, otherwise return
 * the value unchanged. Scans past leading whitespace and control
 * characters (U+0000–U+0020 — the prefix some spreadsheet parsers trim
 * before formula detection), so `' =1+1'`, `'\t=cmd'` and `'\u0000@x'`
 * are guarded too. Applied to text cells only (numeric scientific cells
 * never pass through here — see csvExport.ts) and always BEFORE
 * `escapeCsvField`, so the output remains structurally valid CSV.
 */
export function protectAgainstFormulaInjection(value: string): string {
  let i = 0
  while (i < value.length && value.charCodeAt(i) <= 0x20) i += 1
  return i < value.length && FORMULA_TRIGGERS.has(value.charCodeAt(i))
    ? `'${value}`
    : value
}

/** Escape one CSV field (including edge-whitespace protection). */
export function escapeCsvField(value: string): string {
  const needsQuotes =
    value.includes(',') ||
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value !== value.trim()
  if (!needsQuotes) return value
  return `"${value.replace(/"/g, '""')}"`
}

/** Serialize a header row and data rows to CSV text (UTF-8, CRLF). */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const lines = [headers.map(escapeCsvField).join(',')]
  for (const row of rows) lines.push(row.map(escapeCsvField).join(','))
  return `${lines.join('\r\n')}\r\n`
}
