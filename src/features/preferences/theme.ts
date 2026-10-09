/**
 * Theme application (phase 9B).
 *
 * The established convention is the `.dark` class on the document root
 * (`@custom-variant dark (&:is(.dark *))` and the `.dark` variable block
 * in `src/index.css`) — this module is the only writer of that class, so
 * there is exactly one theme mechanism.
 *
 * System mode follows `prefers-color-scheme` live through a matchMedia
 * listener that is bound only while the preference is `system` and
 * unbound the moment an explicit Light/Dark choice replaces it, so a
 * later operating-system change can never override a manual selection.
 * Environments without `matchMedia` (some test DOMs) resolve `system`
 * to light instead of crashing.
 */
import type { ThemePreference } from './schema'

type SystemListenerCleanup = () => void

let cleanupSystemListener: SystemListenerCleanup | null = null

function systemMediaQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null
}

/**
 * Apply a theme preference to the document root: the class lands
 * synchronously (no effect, no render pass) so startup can apply it
 * before the first paint.
 */
export function applyThemePreference(preference: ThemePreference): void {
  cleanupSystemListener?.()
  cleanupSystemListener = null

  const media = systemMediaQuery()
  const apply = (dark: boolean): void => {
    document.documentElement.classList.toggle('dark', dark)
  }

  if (preference === 'dark') {
    apply(true)
    return
  }
  if (preference === 'light') {
    apply(false)
    return
  }

  // System: resolve now and re-resolve on every OS change, but only while
  // this preference stays active.
  apply(media !== null && media.matches)
  if (media !== null) {
    const onChange = (): void => apply(media.matches)
    media.addEventListener('change', onChange)
    cleanupSystemListener = () => media.removeEventListener('change', onChange)
  }
}
