/**
 * Browser file helpers for the import/export feature — local only.
 *
 * Reading uses the `File` API (`file.text()`); downloads use a blob
 * object URL. At most ONE object URL is alive at a time: creating a new
 * download revokes the previous URL, and a failed click revokes the
 * current one immediately, so repeated exports never leak blob URLs.
 * Export is read-only — nothing here touches the library store or
 * IndexedDB.
 */

/** Read a user-selected file as UTF-8 text. */
export async function readTextFile(file: File): Promise<string> {
  return await file.text()
}

let liveUrl: string | null = null

function revokeLiveUrl(): void {
  if (liveUrl !== null) {
    URL.revokeObjectURL(liveUrl)
    liveUrl = null
  }
}

/** Trigger a browser download of `text` under a sanitized file name. */
export function downloadTextFile(fileName: string, text: string, mimeType: string): void {
  revokeLiveUrl()
  const url = URL.createObjectURL(new Blob([text], { type: mimeType }))
  liveUrl = url
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = fileName
    anchor.rel = 'noopener'
    document.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
  } catch (error) {
    revokeLiveUrl()
    throw error
  }
}

/**
 * Sanitize a library name into a safe cross-platform file name.
 * Non-word characters collapse to `-`; an empty result falls back to
 * "library" so the download can never produce an empty file name.
 */
export function safeFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned === '' ? 'library' : cleaned
}
