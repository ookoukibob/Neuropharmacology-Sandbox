/**
 * Fidelity machinery for the `.npsb` recovery archive (ADR-18, §6 of
 * docs/recovery-backup.md).
 *
 * - `scanRowValue` — export-side boundary: walks a stored row and reports
 *   every value outside the supported domain D (§6.2) with store/key/
 *   path/type, plus the numeric sidecar annotations for `-0`/`NaN`/
 *   `±Infinity`. Nothing is coerced, omitted or repaired.
 * - `decodePointer`/`pointerFromSegments` — RFC 6901 JSON Pointers.
 * - `materializeSpecialNumbers` — restore-side sidecar application with
 *   own-property-only resolution, placeholder checks and rejection of
 *   unannotated special numbers (§6.3).
 * - `deepEqualExact` — the contractual equality `E` (§6.1): `Object.is`
 *   leaves, array length/positions, order-independent own-key sets.
 *
 * Pure and synchronous — no Dexie, no DOM.
 */
import {
  MAX_DEPTH,
  isSpecialNumberKind,
  type RecoveryIssue,
  type RecoveryStoreName,
  type SpecialNumberAnnotation,
  type SpecialNumberKind,
} from './format'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function propertyIsEnumerable(target: object, key: string | symbol): boolean {
  return Object.prototype.propertyIsEnumerable.call(target, key)
}

/** Runtime type name for diagnostics (`"date"`, `"bigint"`, `"map"`, …). */
export function describeValue(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const type = typeof value
  if (type !== 'object') return type
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase()
}

/** IndexedDB key-type name for `BACKUP_UNSUPPORTED_KEY` diagnostics. */
export function describeKeyType(key: unknown): string {
  if (key === null) return 'null'
  if (Array.isArray(key)) return 'array'
  const type = typeof key
  if (type !== 'object') return type
  return Object.prototype.toString.call(key).slice(8, -1).toLowerCase()
}

/**
 * The four special numeric shapes, or `null` for ordinary finite numbers
 * (including `+0`). `Object.is` distinguishes `-0` from `0`.
 */
export function specialNumberKind(value: number): SpecialNumberKind | null {
  if (Number.isNaN(value)) return 'NaN'
  if (Object.is(value, -0)) return '-0'
  if (value === Infinity) return 'Infinity'
  if (value === -Infinity) return '-Infinity'
  return null
}

/**
 * UTF-8 byte-limit check with an early exit. One UTF-16 code unit is at
 * most 3 UTF-8 bytes (a surrogate pair is 2 units → 4 bytes = 2 per
 * unit), so the cheap multiplication is a safe sufficient bound for small
 * texts; only boundary-sized texts take the exact counting path.
 */
export function exceedsUtf8ByteLimit(text: string, limit: number): boolean {
  if (text.length * 3 <= limit) return false
  let bytes = 0
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else {
        // Lone high surrogate → encoded as U+FFFD (3 bytes), like TextEncoder.
        bytes += 3
      }
    } else {
      bytes += 3
    }
    if (bytes > limit) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// RFC 6901 JSON Pointers
// ---------------------------------------------------------------------------

/** Encode one pointer segment (`~` → `~0`, then `/` → `~1`). */
export function encodePointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1')
}

/** Encode path segments as an RFC 6901 pointer (root `""`). */
export function pointerFromSegments(segments: readonly string[]): string {
  return segments.map((segment) => `/${encodePointerSegment(segment)}`).join('')
}

export type PointerDecodeResult =
  | { readonly ok: true; readonly segments: readonly string[] }
  | { readonly ok: false; readonly reason: string }

/**
 * Decode an RFC 6901 pointer. Escape handling is tokenized (`~` must be
 * followed by `0` or `1`) so that `~01` resolves to the literal `~1`
 * exactly as the RFC's ordered replacement specifies, while malformed
 * escapes (`~2`, trailing `~`, `~~`) are rejected instead of silently
 * reinterpreted. The empty root pointer is rejected because the record
 * root is an object — a sidecar must target a descendant property.
 */
export function decodePointer(pointer: string): PointerDecodeResult {
  if (pointer === '') {
    return {
      ok: false,
      reason: 'the empty root pointer cannot address a property (the record root is an object)',
    }
  }
  if (!pointer.startsWith('/')) {
    return { ok: false, reason: 'a JSON Pointer must start with "/"' }
  }
  const segments: string[] = []
  for (const token of pointer.slice(1).split('/')) {
    let decoded = ''
    for (let index = 0; index < token.length; index += 1) {
      const char = token[index]
      if (char === '~') {
        const next = token[index + 1]
        if (next === '0') decoded += '~'
        else if (next === '1') decoded += '/'
        else {
          return {
            ok: false,
            reason: `invalid escape "~${next ?? ''}" in pointer (only ~0 and ~1 are defined)`,
          }
        }
        index += 1
      } else {
        decoded += char
      }
    }
    segments.push(decoded)
  }
  return { ok: true, segments }
}

// ---------------------------------------------------------------------------
// Export-side scan (§6.2)
// ---------------------------------------------------------------------------

export interface RowScanContext {
  readonly store: RecoveryStoreName
  readonly key: string
}

export interface RowScanResult {
  readonly annotations: readonly SpecialNumberAnnotation[]
  readonly issues: readonly RecoveryIssue[]
}

/**
 * Walk one stored row and collect (a) sidecar annotations for every
 * special numeric leaf and (b) structured errors for every value outside
 * the supported domain. Holes, cycles and non-plain prototypes are
 * reported, never repaired; shared (acyclic) references are allowed and
 * serialize as the duplicated trees JSON defines.
 */
export function scanRowValue(value: unknown, ctx: RowScanContext): RowScanResult {
  const annotations: SpecialNumberAnnotation[] = []
  const issues: RecoveryIssue[] = []
  const path: string[] = []
  const ancestors = new Set<object>()

  const unsupported = (node: unknown, detail: string): void => {
    issues.push({
      code: 'BACKUP_UNSUPPORTED_VALUE',
      store: ctx.store,
      key: ctx.key,
      path: pointerFromSegments(path),
      valueType: describeValue(node),
      message: `value of type "${describeValue(node)}" is outside the archive's supported domain (${detail}) at key "${ctx.key}" in ${ctx.store}`,
    })
  }

  const visit = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) {
      issues.push({
        code: 'BACKUP_LIMIT_EXCEEDED',
        store: ctx.store,
        key: ctx.key,
        path: pointerFromSegments(path),
        limit: 'depth',
        message: `value nests deeper than the archive limit of ${MAX_DEPTH} at key "${ctx.key}" in ${ctx.store}`,
      })
      return
    }
    if (typeof node === 'number') {
      const kind = specialNumberKind(node)
      if (kind !== null) annotations.push({ path: pointerFromSegments(path), kind })
      return
    }
    if (node === null || typeof node === 'boolean' || typeof node === 'string') return
    if (typeof node !== 'object') {
      // undefined / bigint / symbol / function — unreachable through every
      // application write path, but the boundary still reports them.
      unsupported(node, 'not serializable as JSON data')
      return
    }
    if (!Array.isArray(node)) {
      const proto = Object.getPrototypeOf(node)
      if (proto !== Object.prototype && proto !== null) {
        // Date/Map/Set/RegExp/ArrayBuffer/typed arrays/Blob/Error and any
        // class instance — prototype identity is not preserved by JSON.
        // (Arrays have Array.prototype and are handled by their own
        // branch below.)
        unsupported(node, 'non-plain prototype')
        return
      }
    }
    if (ancestors.has(node)) {
      issues.push({
        code: 'BACKUP_UNSUPPORTED_VALUE',
        store: ctx.store,
        key: ctx.key,
        path: pointerFromSegments(path),
        valueType: 'cycle',
        message: `value at key "${ctx.key}" in ${ctx.store} contains a circular reference (path ${pointerFromSegments(path)})`,
      })
      return
    }
    ancestors.add(node)
    try {
      if (Array.isArray(node)) {
        let hole = false
        for (let index = 0; index < node.length; index += 1) {
          if (!hasOwn(node, String(index))) {
            hole = true
            break
          }
        }
        if (hole) {
          issues.push({
            code: 'BACKUP_UNSUPPORTED_VALUE',
            store: ctx.store,
            key: ctx.key,
            path: pointerFromSegments(path),
            valueType: 'sparse-array',
            message: `array at key "${ctx.key}" in ${ctx.store} has holes — sparse arrays are not representable in JSON`,
          })
        }
        const keys = Object.keys(node)
        if (!hole && keys.length !== node.length) {
          issues.push({
            code: 'BACKUP_UNSUPPORTED_VALUE',
            store: ctx.store,
            key: ctx.key,
            path: pointerFromSegments(path),
            valueType: 'array-property',
            message: `array at key "${ctx.key}" in ${ctx.store} carries own non-index properties that JSON would drop`,
          })
        }
        if (Object.getOwnPropertySymbols(node).some((symbol) => propertyIsEnumerable(node, symbol))) {
          issues.push({
            code: 'BACKUP_UNSUPPORTED_VALUE',
            store: ctx.store,
            key: ctx.key,
            path: pointerFromSegments(path),
            valueType: 'symbol-key',
            message: `array at key "${ctx.key}" in ${ctx.store} carries enumerable symbol keys that JSON would drop`,
          })
        }
        for (let index = 0; index < node.length; index += 1) {
          const key = String(index)
          if (!hasOwn(node, key)) continue // hole — already reported
          path.push(key)
          visit(node[index], depth + 1)
          path.pop()
        }
        return
      }
      const record = node as Record<string, unknown>
      const names = Object.getOwnPropertyNames(node)
      const keys = Object.keys(node)
      if (names.length !== keys.length) {
        issues.push({
          code: 'BACKUP_UNSUPPORTED_VALUE',
          store: ctx.store,
          key: ctx.key,
          path: pointerFromSegments(path),
          valueType: 'non-enumerable',
          message: `object at key "${ctx.key}" in ${ctx.store} carries non-enumerable own properties that JSON would drop`,
        })
      }
      if (Object.getOwnPropertySymbols(node).some((symbol) => propertyIsEnumerable(node, symbol))) {
        issues.push({
          code: 'BACKUP_UNSUPPORTED_VALUE',
          store: ctx.store,
          key: ctx.key,
          path: pointerFromSegments(path),
          valueType: 'symbol-key',
          message: `object at key "${ctx.key}" in ${ctx.store} carries enumerable symbol keys that JSON would drop`,
        })
      }
      for (const key of keys) {
        path.push(key)
        visit(record[key], depth + 1)
        path.pop()
      }
    } finally {
      ancestors.delete(node)
    }
  }

  visit(value, 0)
  return { annotations, issues }
}

// ---------------------------------------------------------------------------
// Restore-side sidecar materialization (§6.3)
// ---------------------------------------------------------------------------

export interface MaterializeResult {
  readonly ok: boolean
  /** The value with every annotated placeholder replaced (only when ok). */
  readonly value: Record<string, unknown>
  readonly issues: readonly RecoveryIssue[]
}

function canonicalArrayIndex(segment: string, length: number): number | null {
  if (!/^(0|[1-9]\d*)$/.test(segment)) return null
  const index = Number(segment)
  return Number.isSafeInteger(index) && index < length ? index : null
}

/**
 * Validate and apply an entry's `specialNumbers` sidecar to its parsed
 * `value`:
 *
 * 1. annotation shapes, pointer syntax and decoded-path duplicates;
 * 2. an own-property-only walk that rejects unannotated special numbers
 *    and values nesting deeper than `MAX_DEPTH`;
 * 3. per-annotation resolution (own keys only — `__proto__`/`constructor`
 *    are plain data names, never prototype navigation) and the §6.3
 *    placeholder check before any reconstruction.
 *
 * `value` must be `JSON.parse` output (plain, dense, acyclic by
 * construction); it is mutated in place only when the whole entry passes.
 */
export function materializeSpecialNumbers(
  value: Record<string, unknown>,
  annotations: unknown,
  ctx: RowScanContext,
): MaterializeResult {
  const issues: RecoveryIssue[] = []
  const fail = (): MaterializeResult => ({ ok: false, value, issues })

  // 1. Annotation shapes + pointer syntax + decoded-path duplicates.
  interface PreparedAnnotation {
    readonly path: string
    readonly kind: SpecialNumberKind
    readonly segments: readonly string[]
  }
  const list: PreparedAnnotation[] = []
  if (annotations !== undefined) {
    if (!Array.isArray(annotations)) {
      issues.push({
        code: 'ARCHIVE_ANNOTATION_SHAPE',
        store: ctx.store,
        key: ctx.key,
        message: 'specialNumbers must be an array of {path, kind} annotations',
      })
      return fail()
    }
    const seenPaths = new Map<string, number>()
    for (let index = 0; index < annotations.length; index += 1) {
      const annotation: unknown = annotations[index]
      const shapeOk =
        isPlainObject(annotation) &&
        Object.keys(annotation).length === 2 &&
        typeof annotation['path'] === 'string' &&
        isSpecialNumberKind(annotation['kind'])
      if (!shapeOk) {
        issues.push({
          code: 'ARCHIVE_ANNOTATION_SHAPE',
          store: ctx.store,
          key: ctx.key,
          index,
          message: `specialNumbers[${index}] must be an object with exactly a string "path" and one of the four kind literals`,
        })
        continue
      }
      const path = annotation['path'] as string
      const kind = annotation['kind'] as SpecialNumberKind
      const decoded = decodePointer(path)
      if (!decoded.ok) {
        issues.push({
          code: 'ARCHIVE_ANNOTATION_PATH',
          store: ctx.store,
          key: ctx.key,
          index,
          path,
          message: `specialNumbers[${index}].path is not a valid JSON Pointer: ${decoded.reason}`,
        })
        continue
      }
      const identity = JSON.stringify(decoded.segments)
      if (seenPaths.has(identity)) {
        issues.push({
          code: 'ARCHIVE_ANNOTATION_DUPLICATE',
          store: ctx.store,
          key: ctx.key,
          index,
          path,
          message: `specialNumbers[${index}] repeats the pointer of specialNumbers[${String(seenPaths.get(identity))}] (compared after escape decoding)`,
        })
        continue
      }
      seenPaths.set(identity, index)
      list.push({ path, kind, segments: decoded.segments })
    }
    if (issues.length > 0) return fail()
  }

  // 2. Own-property-only walk: depth guard + unannotated special numbers.
  const annotatedIds = new Set(
    list.map((entry) => JSON.stringify(entry.segments)),
  )
  const walkPath: string[] = []
  const walk = (node: unknown, depth: number): void => {
    if (depth > MAX_DEPTH) {
      issues.push({
        code: 'ARCHIVE_LIMIT_EXCEEDED',
        store: ctx.store,
        key: ctx.key,
        path: pointerFromSegments(walkPath),
        limit: 'depth',
        message: `value nests deeper than the archive limit of ${MAX_DEPTH} at key "${ctx.key}" in ${ctx.store}`,
      })
      return
    }
    if (typeof node === 'number') {
      const kind = specialNumberKind(node)
      if (kind !== null && !annotatedIds.has(JSON.stringify(walkPath))) {
        issues.push({
          code: 'ARCHIVE_VALUE_DOMAIN',
          store: ctx.store,
          key: ctx.key,
          path: pointerFromSegments(walkPath),
          valueType: kind,
          message: `unannotated special number (${kind}) at key "${ctx.key}" in ${ctx.store}: ${pointerFromSegments(walkPath) || '(root)'} has no sidecar annotation`,
        })
      }
      return
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walkPath.push(String(index))
        walk(node[index], depth + 1)
        walkPath.pop()
      }
      return
    }
    if (isPlainObject(node)) {
      for (const key of Object.keys(node)) {
        walkPath.push(key)
        walk(node[key], depth + 1)
        walkPath.pop()
      }
    }
  }
  walk(value, 0)
  if (issues.length > 0) return fail()

  // 3. Resolve + placeholder check + reconstruction.
  for (const [index, entry] of list.entries()) {
    const segments = entry.segments
    const last = segments[segments.length - 1]
    if (last === undefined) {
      /* c8 ignore next 3 -- decodePointer never yields an empty segment list */
      issues.push(annotationPathIssue(ctx, index, entry.path, 'pointer has no segments'))
      continue
    }
    let parent: unknown = value
    for (let level = 0; level < segments.length - 1; level += 1) {
      const segment = segments[level]
      if (segment === undefined) {
        /* c8 ignore next 4 -- unreachable: level < segments.length */
        issues.push(annotationPathIssue(ctx, index, entry.path, 'pointer segment is missing'))
        parent = undefined
        break
      }
      if (Array.isArray(parent)) {
        const arrayIndex = canonicalArrayIndex(segment, parent.length)
        if (arrayIndex === null) {
          issues.push(annotationPathIssue(ctx, index, entry.path, `segment "${segment}" is not a canonical in-bounds array index`))
          parent = undefined
          break
        }
        parent = parent[arrayIndex]
      } else if (isPlainObject(parent)) {
        if (!hasOwn(parent, segment)) {
          issues.push(annotationPathIssue(ctx, index, entry.path, `segment "${segment}" is not an own property of the node it traverses`))
          parent = undefined
          break
        }
        parent = parent[segment]
      } else {
        issues.push(annotationPathIssue(ctx, index, entry.path, 'a traversed segment is not a plain object or array'))
        parent = undefined
        break
      }
    }
    // JSON never yields `undefined`, so an undefined parent can only mean
    // a traversal failure above (which already pushed its own issue).
    if (parent === undefined) continue
    let placeholder: unknown
    let writeIndex: number | null = null
    if (Array.isArray(parent)) {
      const arrayIndex = canonicalArrayIndex(last, parent.length)
      if (arrayIndex === null) {
        issues.push(annotationPathIssue(ctx, index, entry.path, `segment "${last}" is not a canonical in-bounds array index`))
        continue
      }
      writeIndex = arrayIndex
      placeholder = parent[arrayIndex]
    } else if (isPlainObject(parent)) {
      if (!hasOwn(parent, last)) {
        issues.push(annotationPathIssue(ctx, index, entry.path, `segment "${last}" is not an own property of the node it addresses`))
        continue
      }
      placeholder = parent[last]
    } else {
      issues.push(annotationPathIssue(ctx, index, entry.path, 'the pointer does not address a plain object or array property'))
      continue
    }
    const matches =
      entry.kind === '-0'
        ? typeof placeholder === 'number' && placeholder === 0
        : placeholder === null
    if (!matches) {
      issues.push({
        code: 'ARCHIVE_ANNOTATION_PLACEHOLDER',
        store: ctx.store,
        key: ctx.key,
        index,
        path: entry.path,
        message: `specialNumbers[${index}] expects the §6.3 placeholder ${entry.kind === '-0' ? 'a number equal to 0' : 'null'} at ${entry.path} of key "${ctx.key}" in ${ctx.store}, found ${describeValue(placeholder)}`,
      })
      continue
    }
    const replacement =
      entry.kind === '-0' ? -0 : entry.kind === 'NaN' ? NaN : entry.kind === 'Infinity' ? Infinity : -Infinity
    // The addressed key was proven own above, so this assignment can only
    // hit that own data property — even for the literal name "__proto__",
    // the own property shadows the inherited setter.
    if (writeIndex !== null && Array.isArray(parent)) parent[writeIndex] = replacement
    else if (isPlainObject(parent)) parent[last] = replacement
  }
  if (issues.length > 0) return fail()
  return { ok: true, value, issues: [] }
}

function annotationPathIssue(
  ctx: RowScanContext,
  index: number,
  path: string,
  reason: string,
): RecoveryIssue {
  return {
    code: 'ARCHIVE_ANNOTATION_PATH',
    store: ctx.store,
    key: ctx.key,
    index,
    path,
    message: `specialNumbers[${index}].path (${path}) cannot be resolved on key "${ctx.key}" in ${ctx.store}: ${reason}`,
  }
}

// ---------------------------------------------------------------------------
// Contractual deep equality E (§6.1)
// ---------------------------------------------------------------------------

/**
 * Deep equality with `Object.is` leaves: `NaN` equals `NaN`, `0` and `-0`
 * differ, arrays compare by length and dense positions, objects by their
 * own enumerable key sets (order-independent). Prototypes and key order
 * are not contractual (§6.1).
 */
export function deepEqualExact(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let index = 0; index < a.length; index += 1) {
      if (!deepEqualExact(a[index], b[index])) return false
    }
    return true
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a)
    const keysB = Object.keys(b)
    if (keysA.length !== keysB.length) return false
    for (const key of keysA) {
      if (!hasOwn(b, key)) return false
      if (!deepEqualExact(a[key], b[key])) return false
    }
    return true
  }
  return false
}
