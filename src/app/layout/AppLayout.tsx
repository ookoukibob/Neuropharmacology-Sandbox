import { Calculator, Library, ArrowLeftRight, Settings } from 'lucide-react'
import { useEffect } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
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

/**
 * Application shell: header navigation, main content outlet, footer notice.
 * Placeholder only — feature views are implemented in later phases.
 */
export function AppLayout() {
  // Hydrate the drug library from IndexedDB exactly once per mount; the
  // store guards against the StrictMode double-invoke.
  const hydrate = useLibraryStore((s) => s.hydrate)
  useEffect(() => {
    void hydrate()
  }, [hydrate])

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
          <div className="mx-auto flex h-14 w-full max-w-6xl items-center justify-between gap-6 px-4">
            <NavLink
              to="/library"
              className="flex items-center gap-2 text-sm font-semibold tracking-tight"
            >
              <Library className="size-4 text-muted-foreground" aria-hidden="true" />
              <span>Neuropharmacology Sandbox</span>
            </NavLink>

            <nav aria-label="Primary" className="flex items-center gap-1">
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

        <main id="main-content" className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">
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
