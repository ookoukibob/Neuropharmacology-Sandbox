/**
 * Stable identifier generation for stored records.
 *
 * Drug and target ids are opaque UUID v4 strings (never array positions and
 * never names): records can be re-ordered, renamed or imported without
 * breaking references. crypto is the platform-neutral source — browsers and
 * Node ≥ 19 both expose it; there is no weak fallback, because a guessable
 * id would silently break the stability contract.
 */
export function newId(): string {
  const c = globalThis.crypto
  if (typeof c?.randomUUID === 'function') return c.randomUUID()
  if (typeof c?.getRandomValues === 'function') {
    const bytes = c.getRandomValues(new Uint8Array(16))
    // RFC 4122 version 4 / variant 10xx layout.
    bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
    bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new Error('secure random id generation is unavailable in this environment')
}
