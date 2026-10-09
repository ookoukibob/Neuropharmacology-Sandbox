/**
 * File helper tests — file-name sanitization and object-URL lifecycle
 * (at most one live URL, revoked when replaced or on failure).
 */
import { describe, expect, it, vi } from 'vitest'
import { downloadTextFile, safeFileName } from './fileIo'

describe('safeFileName', () => {
  it('keeps simple names', () => {
    expect(safeFileName('My Library')).toBe('My-Library')
    expect(safeFileName('local.v2')).toBe('local.v2')
  })

  it('removes path and shell sensitive characters', () => {
    expect(safeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('trims separator edges and collapses repeats', () => {
    expect(safeFileName('--  name  --')).toBe('name')
  })

  it('falls back to "library" when nothing survives', () => {
    expect(safeFileName('   ')).toBe('library')
    expect(safeFileName('!!!')).toBe('library')
  })
})

describe('downloadTextFile', () => {
  it('creates one object URL per download and revokes the previous one', () => {
    const created = vi
      .fn<(blob: Blob) => string>()
      .mockReturnValueOnce('blob:one')
      .mockReturnValueOnce('blob:two')
    const revoked = vi.fn<(url: string) => void>()
    URL.createObjectURL = created
    URL.revokeObjectURL = revoked

    downloadTextFile('a.npsl', '{"a":1}', 'application/json')
    expect(created).toHaveBeenCalledTimes(1)
    expect(created.mock.calls[0]?.[0].type).toBe('application/json')
    expect(revoked).not.toHaveBeenCalled()

    downloadTextFile('b.csv', 'a,b\r\n', 'text/csv')
    expect(revoked).toHaveBeenCalledWith('blob:one')
    expect(revoked).toHaveBeenCalledTimes(1)
  })

  it('revokes the URL when the click fails', () => {
    const revoked = vi.fn<(url: string) => void>()
    URL.createObjectURL = vi.fn(() => 'blob:three')
    URL.revokeObjectURL = revoked
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(() => {
        throw new Error('blocked')
      })

    expect(() => downloadTextFile('a.npsl', '{}', 'application/json')).toThrow('blocked')
    expect(revoked).toHaveBeenCalledWith('blob:three')
    click.mockRestore()
  })
})
