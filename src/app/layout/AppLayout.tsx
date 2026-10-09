import { Calculator, Library, ArrowLeftRight, Settings } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useLibraryStore } from '@/app/libraryStore'
import { cn } from 'cn'

interface NavItem {
  readonly to: string
  readonly label: string
  readonly icon: typeof Library
}

const NAV_ITEMS: readonly NavItem[] = [
  { to: '/library', label: 'Drug Library', icon: Library },
  { to: '/calculator', label: 'Calculator', icon: Calculator },
  { to: '/import-export', label: 'Import / Export', icon: ArrowLeftRight },
  { to: '/settings', label: 'Settings', icon: Settings },
]

/** Document title for a route path (SPA navigation must keep it meaningful). */
function titleForPath(pathname: string): string {
  if (pathname === '/library/new') return 'New Drug Record'
  if (pathname === '/library' || pathname === '/') return 'Drug Library'
  if (pathname === '/calculator') return 'Calculator'
  if (pathname === '/import-export') return 'Import / Export'
  if (pathname === '/settings') return 'Settings'
  if (/^\/library\/[^/]+$/.test(pathname)) return 'Drug Detail'
  return 'Page not found'
}

/**
 * Application shell: header navigation, main content outlet, footer notice.
 *
 * Accessibility behaviour:
 * - the skip link is the first focusable element and targets `<main>`;
 * - every route change updates the document title and moves keyboard focus
 *   to the main region, so keyboard and screen-reader users land in the new
 *   content (only on route changes — never while an input is being edited);
 * - the header wraps instead of overflowing at narrow viewport widths.
 */
export function AppLayout() {
  // Hydrate the drug library from IndexedDB exactly once per mount; the
  // store guards against the StrictMode double-invoke.
  const hydrate = useLibraryStore((s) => s.hydrate)
  const { pathname } = useLocation()
  const mainRef = useRef<HTMLElement>(null)
  const firstRender = useRef(true)

  useEffect(() => {
    void hydrate()
  }, [hydrate])

  // Meaningful page title for every route (including client-side changes).
  useEffect(() => {
    document.title = `${titleForPath(pathname)} — Neuropharmacology Sandbox`
  }, [pathname])

  // Predictable focus placement after navigation. Skipped on the initial
  // load (the document itself has focus) and only keyed on the path, so
  // in-page query-string updates (calculator drafts, filters) never steal
  // focus from someone who is typing.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false
      return
    }
    mainRef.current?.focus()
  }, [pathname])

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex min-h-screen flex-col bg-background text-foreground">
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-3 focus:py-2 focus:text-sm"
        >
          Skip to main content
        </a>

        <header className="border-b border-border bg-card">
          <div className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-2">
            <NavLink
              to="/library"
              className="flex items-center gap-2 text-sm font-semibold tracking-tight"
            >
              <Library className="size-4 text-muted-foreground" aria-hidden="true" />
              <span>Neuropharmacology Sandbox</span>
            </NavLink>

            <nav aria-label="Primary" className="flex flex-wrap items-center gap-1">
              {NAV_ITEMS.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  className={({ isActive }) =>
                    cn(
                      'inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition-colors',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                      isActive
                        ? 'bg-muted text-foreground'
                        : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                    )
                  }
                >
                  <Icon className="size-4" aria-hidden="true" />
                  {label}
                </NavLink>
              ))}
            </nav>
          </div>
        </header>

        <main
          id="main-content"
          ref={mainRef}
          tabIndex={-1}
          className="mx-auto w-full max-w-6xl flex-1 px-4 py-8 focus:outline-none"
        >
          <Outlet />
        </main>

        <footer className="border-t border-border bg-card py-3">
          <p className="mx-auto w-full max-w-6xl px-4 text-xs text-muted-foreground">
            Transparent, reproducible pharmacology calculations. Not a clinical
            decision-support system and not a substitute for authoritative
            pharmacology databases.
          </p>
        </footer>
      </div>
    </TooltipProvider>
  )
}
