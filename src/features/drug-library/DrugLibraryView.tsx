/**
 * Minimal library view (phase 3): list, simple name filter, selection via
 * navigation, quarantine report, and a create entry point. Deliberately
 * minimal — no charts, no dashboards, no advanced search, no AI.
 */
import { AlertTriangle, Plus } from 'lucide-react'
import { NavLink, useNavigate } from 'react-router-dom'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useLibraryStore } from '@/app/libraryStore'
import { OriginBadge } from './components/OriginBadge'

export function DrugLibraryView() {
  const navigate = useNavigate()
  const status = useLibraryStore((s) => s.status)
  const drugs = useLibraryStore((s) => s.drugs)
  const quarantine = useLibraryStore((s) => s.quarantine)
  const filter = useLibraryStore((s) => s.filter)
  const error = useLibraryStore((s) => s.error)
  const setFilter = useLibraryStore((s) => s.setFilter)

  const needle = filter.trim().toLowerCase()
  const visible = needle.length === 0
    ? drugs
    : drugs.filter(
        (drug) =>
          drug.identifiers.name.toLowerCase().includes(needle) ||
          drug.identifiers.synonyms.some((s) => s.toLowerCase().includes(needle)),
      )

  if (status !== 'ready') {
    return (
      <p className="text-sm text-muted-foreground">
        {status === 'error' ? `Library failed to load: ${error ?? 'unknown error'}` : 'Loading library…'}
      </p>
    )
  }

  return (
    <div className="space-y-4">
      {quarantine.length > 0 && (
        <Alert variant="destructive" data-testid="quarantine-banner">
          <AlertTriangle aria-hidden="true" className="size-4" />
          <AlertTitle>Unreadable records kept in storage</AlertTitle>
          <AlertDescription>
            {quarantine.length} stored record{quarantine.length === 1 ? '' : 's'} failed validation
            and {quarantine.length === 1 ? 'was' : 'were'} left untouched (never deleted). Ids:{' '}
            {quarantine.map((q) => q.id).join(', ')}
          </AlertDescription>
        </Alert>
      )}

      {error !== null && status === 'ready' && (
        <Alert variant="destructive" data-testid="library-error">
          <AlertTitle>Last operation failed</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="grid w-full max-w-sm gap-2">
          <Label htmlFor="library-filter">Filter by name or synonym</Label>
          <Input
            id="library-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="e.g. Compound"
            data-testid="library-filter"
          />
        </div>
        <Button onClick={() => navigate('/library/new')} data-testid="new-drug">
          <Plus aria-hidden="true" className="size-4" />
          New drug
        </Button>
      </div>

      <p className="text-sm text-muted-foreground" data-testid="library-count">
        {visible.length} of {drugs.length} record{drugs.length === 1 ? '' : 's'}
      </p>

      {drugs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          The library is empty. Records you create are stored locally in your browser.
        </p>
      ) : (
        <ul className="grid gap-2" data-testid="drug-list">
          {visible.map((drug) => (
            <li key={drug.id}>
              <NavLink to={`/library/${drug.id}`} className="block">
                <Card>
                  <CardContent className="flex flex-wrap items-center gap-2 py-3">
                    <span className="font-medium">{drug.identifiers.name}</span>
                    <OriginBadge origin={drug.origin} />
                    {drug.tags.map((tag) => (
                      <span key={tag} className="text-xs text-muted-foreground">
                        #{tag}
                      </span>
                    ))}
                  </CardContent>
                </Card>
              </NavLink>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
