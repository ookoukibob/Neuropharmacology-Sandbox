/**
 * RFC 4180 CSV writer for the export side of the import/export feature.
 *
 * Every field is escaped — a value containing a delimiter, quote, line
 * break or edge whitespace is quoted and its quotes doubled. Nothing is
 * ever concatenated raw, so names, descriptions and provenance JSON can
 * contain commas, quotes and newlines without corrupting the file.
 *
 * Records are separated by CRLF and the file ends with a record
 * separator, as recommended by RFC 4180 and expected by spreadsheet
 * tools. Quote or not:
 *
 *   needsQuoting("a,b")   → '"a,b"'
 *   needsQuoting('say"')  → '"say"""'
 *   needsQuoting("x\ny")  → '"x\ny"'
 */

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
