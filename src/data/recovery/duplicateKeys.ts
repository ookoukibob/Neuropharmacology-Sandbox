/**
 * String-aware duplicate JSON object-key scanner (docs/recovery-backup.md
 * §8.2/2).
 *
 * `JSON.parse` silently keeps the LAST value of a duplicated key and a
 * reviver only sees post-collapse objects, so restore must reject
 * duplicated keys with a textual scan before parsing. Requirements met
 * here (Phase 8B §15.5/2 resolved):
 *
 * - **string-aware**: structural characters inside quoted strings never
 *   count (the scanner tracks string/escape state), so a `"drugs":`
 *   sequence inside a string value cannot false-positive;
 * - **decoded names**: property names are compared after JSON string
 *   decoding, so a literal character and its escape are the
 *   same key (`{"a":1,"a":2}` is a duplicate);
 * - **iterative and bounded**: an explicit frame stack (no recursion),
 *   depth capped by `maxDepth`, input size capped by the caller
 *   (`MAX_ARCHIVE_BYTES`, checked before the scan);
 * - **malformed input** is reported as `malformed` and left to
 *   `JSON.parse`, which produces the user-facing `ARCHIVE_PARSE` error.
 */

export type DuplicateKeyScanResult =
  | { readonly ok: true }
  | {
      readonly ok: false
      readonly reason: 'duplicate'
      /** The decoded property name that appeared twice. */
      readonly key: string
      readonly line: number
      readonly column: number
    }
  | { readonly ok: false; readonly reason: 'depth'; readonly depth: number }
  | { readonly ok: false; readonly reason: 'malformed' }

interface Frame {
  readonly kind: 'object' | 'array'
  /** Decoded key names already seen in THIS object, with positions. */
  readonly keys: Map<string, { readonly line: number; readonly column: number }> | null
  /** True when the next string inside an object is a property name. */
  expectKey: boolean
}

const MALFORMED: DuplicateKeyScanResult = { ok: false, reason: 'malformed' }

const DELIMITERS = ' \t\n\r,}[]:'

function isHexDigit(char: string): boolean {
  return (
    (char >= '0' && char <= '9') ||
    (char >= 'a' && char <= 'f') ||
    (char >= 'A' && char <= 'F')
  )
}

/**
 * Scan JSON text for duplicated object keys. Returns the FIRST duplicate
 * in textual order with its decoded name and 1-based line/column, or a
 * structural `depth`/`malformed` result. Never throws; O(n) in input
 * length with O(entries) memory per open object.
 */
export function scanDuplicateJsonKeys(text: string, maxDepth: number): DuplicateKeyScanResult {
  const stack: Frame[] = []
  let index = 0
  let line = 1
  let column = 1

  const advanceTo = (next: number): void => {
    for (; index < next; index += 1) {
      if (text[index] === '\n') {
        line += 1
        column = 1
      } else {
        column += 1
      }
    }
  }

  /** Read a string token starting at `start` (the opening quote). */
  const readString = (start: number): { decoded: string; next: number } | null => {
    let cursor = start + 1
    let decoded = ''
    for (;;) {
      const char = text[cursor]
      if (char === undefined) return null // unterminated
      if (char === '"') return { decoded, next: cursor + 1 }
      if (char === '\\') {
        const escape = text[cursor + 1]
        if (escape === undefined) return null
        if (escape === '"' || escape === '\\' || escape === '/') {
          decoded += escape
          cursor += 2
        } else if (escape === 'b') {
          decoded += '\b'
          cursor += 2
        } else if (escape === 'f') {
          decoded += '\f'
          cursor += 2
        } else if (escape === 'n') {
          decoded += '\n'
          cursor += 2
        } else if (escape === 'r') {
          decoded += '\r'
          cursor += 2
        } else if (escape === 't') {
          decoded += '\t'
          cursor += 2
        } else if (escape === 'u') {
          const hex = text.slice(cursor + 2, cursor + 6)
          if (hex.length !== 4) return null
          let valid = true
          for (let offset = 0; offset < 4; offset += 1) {
            if (!isHexDigit(hex[offset] as string)) {
              valid = false
              break
            }
          }
          if (!valid) return null
          decoded += String.fromCharCode(Number.parseInt(hex, 16))
          cursor += 6
        } else {
          return null // unknown escape — malformed JSON
        }
        continue
      }
      const code = char.charCodeAt(0)
      if (code < 0x20) return null // raw control char in string
      decoded += char
      cursor += 1
    }
  }

  while (index < text.length) {
    const char = text[index] as string
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      advanceTo(index + 1)
      continue
    }
    if (char === '{' || char === '[') {
      const kind: Frame['kind'] = char === '{' ? 'object' : 'array'
      if (stack.length + 1 > maxDepth) {
        return { ok: false, reason: 'depth', depth: stack.length + 1 }
      }
      stack.push({
        kind,
        keys: kind === 'object' ? new Map() : null,
        expectKey: kind === 'object',
      })
      advanceTo(index + 1)
      continue
    }
    if (char === '}' || char === ']') {
      // Popping an empty stack stays malformed-friendly: JSON.parse owns
      // final syntax validity and reports ARCHIVE_PARSE.
      stack.pop()
      advanceTo(index + 1)
      continue
    }
    if (char === ',') {
      const frame = stack[stack.length - 1]
      if (frame === undefined) return MALFORMED // comma at document level
      if (frame.kind === 'object') frame.expectKey = true
      advanceTo(index + 1)
      continue
    }
    if (char === ':') {
      const frame = stack[stack.length - 1]
      if (frame === undefined || frame.kind !== 'object' || frame.expectKey) return MALFORMED
      advanceTo(index + 1)
      continue
    }
    if (char === '"') {
      const token = readString(index)
      if (token === null) return MALFORMED
      const frame = stack[stack.length - 1]
      if (frame !== undefined && frame.kind === 'object' && frame.expectKey) {
        const startLine = line
        const startColumn = column
        const previous = frame.keys?.get(token.decoded)
        if (previous !== undefined) {
          return {
            ok: false,
            reason: 'duplicate',
            key: token.decoded,
            line: startLine,
            column: startColumn,
          }
        }
        frame.keys?.set(token.decoded, { line: startLine, column: startColumn })
        frame.expectKey = false // after a key comes its value (":")
      }
      advanceTo(token.next)
      continue
    }
    // A bare atom (number, true/false/null) — in a key position that is
    // malformed JSON (`{a:1}`); in a value position it is fine. Read to
    // the next delimiter; JSON.parse owns the final syntax verdict.
    let cursor = index
    while (cursor < text.length && !DELIMITERS.includes(text[cursor] as string)) {
      cursor += 1
    }
    if (cursor === index) return MALFORMED
    const frame = stack[stack.length - 1]
    if (frame !== undefined && frame.kind === 'object' && frame.expectKey) return MALFORMED
    advanceTo(cursor)
  }

  if (stack.length > 0) return MALFORMED // unterminated container
  return { ok: true }
}
