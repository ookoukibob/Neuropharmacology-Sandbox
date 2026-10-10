/**
 * Data sources feature root: the on-demand retrieval flow.
 *
 * Layout: source + scope picker → search → results with explicit
 * selection → measurements fetch → preview + confirm import → stored
 * data panel (below). Every network action lives in the store and only
 * runs on an explicit user gesture — this view performs none on its own
 * (mount only re-reads already-stored records from IndexedDB).
 *
 * Honesty rules visible here:
 * - preview counts are labelled advisory — the repository re-validates
 *   atomically at commit time, so a stale list can never smuggle data in;
 * - rejected/failed imports say "nothing was written";
 * - measurement rows show the source record link, retrieval time and
 *   license, and the endpoint-filter selection is stated wherever the
 *   fetched list is shown (the label describes the data actually
 *   fetched, never the current setting).
 */
import { useEffect, useMemo, useState } from 'react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useDataSourcesStore } from '@/app/dataSourcesStore'
import type { SearchScope } from '../../data/sources/types'
import { importPreviewOf, type SourceSummary } from './store'
import { ObservationSummary } from './ObservationSummary'
import { StoredDataPanel } from './StoredDataPanel'

const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-2 text-sm'

/** Source attribution line for the currently chosen source. */
function AttributionLine({ summary }: { readonly summary: SourceSummary | undefined }) {
  if (summary === undefined || summary.licenseNotice === undefined) return null
  return (
    <p className="text-xs text-muted-foreground" data-testid="source-attribution">
      {summary.licenseNotice}
      {summary.licenseUrl !== undefined && (
        <>
          {' '}
          <a
            href={summary.licenseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2"
          >
            License & attribution
          </a>
        </>
      )}
    </p>
  )
}

/** Source picker, search scope, query and the retrieval-filter selector. */
function SourceSearchCard() {
  const state = useDataSourcesStore()
  const setSource = state.setSource
  const setScope = state.setScope
  const setQuery = state.setQuery
  const setEndpointScope = state.setEndpointScope
  const runSearch = state.runSearch
  const cancelSearch = state.cancelSearch

  const summary = state.sources.find((source) => source.id === state.sourceId)
  const searching = state.search.status === 'searching'
  const supportedScopes: readonly SearchScope[] = summary?.searchScopes ?? ['compounds']

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Search an external source</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="source-select">Data source</Label>
            <select
              id="source-select"
              data-testid="source-select"
              className={SELECT_CLASS}
              value={state.sourceId}
              onChange={(e) => setSource(e.target.value)}
            >
              {state.sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.name}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {summary?.description ?? 'No source configured.'}
            </p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="endpoint-scope-select">Measurement endpoints to retrieve</Label>
            <select
              id="endpoint-scope-select"
              data-testid="endpoint-scope-select"
              className={SELECT_CLASS}
              value={state.endpointScope}
              disabled={summary?.offersObservations !== true}
              onChange={(e) => {
                if (e.target.value === 'parameters' || e.target.value === 'all') {
                  setEndpointScope(e.target.value)
                }
              }}
            >
              <option value="parameters">Model parameters (Ki, Kd, IC50, EC50)</option>
              <option value="all">All reported endpoints</option>
            </select>
            <p className="text-xs text-muted-foreground">
              This filter is sent to the source — only the chosen scope is downloaded. Records
              fetched under another scope are cleared so the label always describes the data on
              screen.
            </p>
          </div>
        </div>

        <div className="grid gap-2">
          <Label>Search scope</Label>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Search scope">
            <Button
              type="button"
              size="sm"
              variant={state.scope === 'compounds' ? 'default' : 'outline'}
              aria-pressed={state.scope === 'compounds'}
              data-testid="scope-compounds"
              onClick={() => setScope('compounds')}
            >
              Compounds
            </Button>
            <Button
              type="button"
              size="sm"
              variant={state.scope === 'targets' ? 'default' : 'outline'}
              aria-pressed={state.scope === 'targets'}
              data-testid="scope-targets"
              disabled={!supportedScopes.includes('targets')}
              onClick={() => setScope('targets')}
            >
              Targets
            </Button>
          </div>
        </div>

        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch()
          }}
        >
          <div className="grid min-w-56 flex-1 gap-2">
            <Label htmlFor="source-query">
              {state.scope === 'targets' ? 'Target name or keyword' : 'Compound name, CAS or InChIKey'}
            </Label>
            <Input
              id="source-query"
              data-testid="query-input"
              value={state.query}
              placeholder={state.scope === 'targets' ? 'e.g. serotonin transporter' : 'e.g. fluoxetine'}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <Button type="submit" data-testid="search-button" disabled={searching}>
            {searching ? 'Searching…' : 'Search'}
          </Button>
          {searching && (
            <Button
              type="button"
              variant="outline"
              data-testid="cancel-search-button"
              onClick={cancelSearch}
            >
              Cancel
            </Button>
          )}
        </form>

        <AttributionLine summary={summary} />
        <p className="text-xs text-muted-foreground" data-testid="on-demand-notice">
          Nothing is downloaded until you press Search or Fetch measurements — this app never
          contacts a source on its own and bundles no default database.
        </p>
      </CardContent>
    </Card>
  )
}

/** Search outcome: loading / error / empty / selectable results. */
function SearchResultsCard() {
  const state = useDataSourcesStore()
  const toggleCompound = state.toggleCompound
  const setActiveTarget = state.setActiveTarget
  const runSearch = state.runSearch
  const search = state.search

  if (search.status === 'idle') return null

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Search results</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p role="status" aria-live="polite" data-testid="search-status">
          {search.status === 'searching' && 'Searching…'}
          {search.status === 'results' &&
            `${search.compounds.length > 0 ? search.compounds.length : search.targets.length} result${
              (search.compounds.length > 0 ? search.compounds.length : search.targets.length) === 1
                ? ''
                : 's'
            }`}
          {search.status === 'empty' && `No matches for “${state.query.trim()}”.`}
          {search.status === 'error' && 'The search failed.'}
        </p>

        {search.status === 'error' && (
          <Alert variant="destructive" data-testid="search-error">
            <AlertTitle>Search failed — nothing was fetched</AlertTitle>
            <AlertDescription>
              {search.error}
              <div className="mt-2">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  data-testid="retry-search"
                  onClick={() => void runSearch()}
                >
                  Retry
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        )}

        {search.status === 'results' && search.compounds.length > 0 && (
          <ul className="space-y-2" data-testid="compound-results">
            {search.compounds.map((compound) => (
              <li
                key={compound.id}
                className="flex items-start gap-3 rounded-md border p-3 text-sm"
                data-testid="compound-result"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={`Select compound ${compound.name ?? compound.sourceId}`}
                  data-testid={`compound-select-${compound.id}`}
                  checked={state.selectedCompoundIds.includes(compound.id)}
                  onChange={() => toggleCompound(compound.id)}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">
                    {compound.name ?? compound.sourceId}
                    <span className="ml-2 font-normal text-muted-foreground">
                      {compound.source} record {compound.sourceId}
                    </span>
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {[
                      compound.identifiers.molecularFormula !== undefined
                        ? `formula ${compound.identifiers.molecularFormula}`
                        : null,
                      compound.identifiers.molecularWeight !== undefined
                        ? `MW ${compound.identifiers.molecularWeight} g/mol`
                        : null,
                      compound.identifiers.casNumber !== undefined
                        ? `CAS ${compound.identifiers.casNumber}`
                        : null,
                      compound.identifiers.inchiKey !== undefined
                        ? `InChIKey ${compound.identifiers.inchiKey}`
                        : null,
                    ]
                      .filter((part): part is string => part !== null)
                      .join(' · ')}
                  </p>
                  {compound.synonyms.length > 0 && (
                    <p className="break-words text-xs text-muted-foreground">
                      Synonyms: {compound.synonyms.slice(0, 4).join(', ')}
                      {compound.synonyms.length > 4 ? ` (+${compound.synonyms.length - 4} more)` : ''}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {search.status === 'results' && search.targets.length > 0 && (
          <ul className="space-y-2" data-testid="target-results">
            {search.targets.map((target) => {
              const active = state.activeTarget?.sourceTargetId === target.sourceTargetId
              return (
                <li
                  key={target.sourceTargetId}
                  className="flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm"
                  data-testid="target-result"
                >
                  <Button
                    type="button"
                    size="sm"
                    variant={active ? 'default' : 'outline'}
                    aria-pressed={active}
                    data-testid={`target-select-${target.sourceTargetId}`}
                    onClick={() => setActiveTarget(active ? null : target)}
                  >
                    {active ? 'Selected' : 'Use this target'}
                  </Button>
                  <div>
                    <p className="font-medium">{target.name ?? target.sourceTargetId}</p>
                    <p className="text-xs text-muted-foreground">
                      {[
                        target.sourceTargetId,
                        target.organism ?? null,
                        target.targetType ?? null,
                      ]
                        .filter((part): part is string => part !== null)
                        .join(' · ')}
                    </p>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function endpointScopeLabel(scope: 'parameters' | 'all'): string {
  return scope === 'parameters' ? 'model parameters only' : 'all reported endpoints'
}

/** Fetch + select + page the measurements of the current selection. */
function MeasurementsCard() {
  const state = useDataSourcesStore()
  const fetchObservations = state.fetchObservations
  const loadMoreObservations = state.loadMoreObservations
  const clearObservations = state.clearObservations
  const toggleObservation = state.toggleObservation
  const summary = state.sources.find((source) => source.id === state.sourceId)
  const observations = state.observations
  const fetching = observations.status === 'loading'

  if (summary?.offersObservations !== true) {
    // Identity-only source (PubChem): say so instead of pretending.
    return (
      <Card data-testid="observations-unavailable">
        <CardHeader>
          <CardTitle headingLevel={2}>Measurements</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {summary?.name ?? 'This source'} provides compound identity records in this app — it is
            not presented as an activity source. ChEMBL offers measured endpoints.
          </p>
        </CardContent>
      </Card>
    )
  }

  const canFetch =
    state.scope === 'targets'
      ? state.activeTarget !== null
      : state.selectedCompoundIds.length > 0

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Measurements</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            data-testid="fetch-observations-button"
            disabled={fetching || !canFetch}
            onClick={() => void fetchObservations()}
          >
            {fetching ? 'Fetching…' : 'Fetch measurements'}
          </Button>
          {observations.status === 'ready' && (
            <Button
              type="button"
              variant="outline"
              data-testid="clear-observations"
              onClick={clearObservations}
            >
              Clear list
            </Button>
          )}
          {!canFetch && (
            <p className="text-xs text-muted-foreground" data-testid="fetch-hint">
              {state.scope === 'targets'
                ? 'Select a target in the results first.'
                : 'Select at least one compound in the results first.'}
            </p>
          )}
        </div>

        <p role="status" aria-live="polite" data-testid="observations-status">
          {fetching && 'Fetching measurements…'}
          {observations.status === 'ready' &&
            `${observations.items.length} measurement${observations.items.length === 1 ? '' : 's'}${
              observations.total !== null ? ` of ${observations.total}` : ''
            } · fetched for ${observations.fetchedFor ?? 'the selection'} · endpoints: ${
              endpointScopeLabel(state.endpointScope)
            }${observations.omitted > 0 ? ` · ${observations.omitted} supplied row(s) carried no usable measurement` : ''}`}
          {observations.status === 'idle' && 'No measurements fetched yet.'}
        </p>

        {observations.status === 'error' && (
          <Alert variant="destructive" data-testid="observations-error">
            <AlertTitle>Fetching measurements failed</AlertTitle>
            <AlertDescription>{observations.error}</AlertDescription>
          </Alert>
        )}

        {observations.status === 'ready' && observations.items.length === 0 && (
          <p className="text-sm text-muted-foreground" data-testid="observations-empty">
            No measurements matched{state.endpointScope === 'parameters' ? ' with this endpoint filter' : ''} —
            nothing was written. Try the other endpoint scope, or search another compound.
          </p>
        )}

        {observations.items.length > 0 && (
          <ul className="space-y-2" data-testid="observation-rows">
            {observations.items.map((observation) => (
              <li
                key={observation.id}
                className="flex items-start gap-3 rounded-md border p-3 text-sm"
                data-testid="observation-row"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label={`Select measurement ${observation.id} of ${observation.compoundName ?? observation.compoundSourceId}`}
                  data-testid={`observation-select-${observation.id}`}
                  checked={state.selectedObservationIds.includes(observation.id)}
                  onChange={() => toggleObservation(observation.id)}
                />
                <ObservationSummary observation={observation} />
              </li>
            ))}
          </ul>
        )}

        {observations.nextOffset !== null && observations.pageSource !== null && (
          <Button
            type="button"
            variant="outline"
            data-testid="load-more-observations"
            disabled={fetching}
            onClick={() => void loadMoreObservations()}
          >
            Load more ({observations.items.length} of {observations.total ?? '?'} loaded)
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

/** Selection preview + explicit confirm + honest outcome report. */
function ImportCard() {
  const state = useDataSourcesStore()
  const [busy, setBusy] = useState(false)
  const preview = useMemo(() => importPreviewOf(state), [state])
  const selectedTotal = preview.compounds + preview.observations

  async function onImport(): Promise<void> {
    setBusy(true)
    try {
      await state.importSelected()
    } finally {
      setBusy(false)
    }
  }

  if (selectedTotal === 0 && state.importOutcome === null) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle headingLevel={2}>Confirm import</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p data-testid="import-preview-text">
          Selected: {preview.compounds} compound identity record
          {preview.compounds === 1 ? '' : 's'}
          {preview.existingCompounds > 0
            ? ` (${preview.existingCompounds} already stored — they will be kept unchanged)`
            : ''}
          , {preview.observations} measurement record{preview.observations === 1 ? '' : 's'}
          {preview.existingObservations > 0
            ? ` (${preview.existingObservations} already stored — they will be kept unchanged)`
            : ''}
          .
        </p>
        <p className="text-xs text-muted-foreground">
          This preview is advisory — the repository re-validates every record inside one atomic
          transaction and can still reject the import. Existing records are never overwritten.
        </p>
        <Button
          type="button"
          data-testid="confirm-import-button"
          disabled={busy || selectedTotal === 0}
          onClick={() => void onImport()}
        >
          {busy ? 'Importing…' : `Import ${selectedTotal} record${selectedTotal === 1 ? '' : 's'}`}
        </Button>
        <ImportOutcomeReport />
      </CardContent>
    </Card>
  )
}

function ImportOutcomeReport() {
  const outcome = useDataSourcesStore((s) => s.importOutcome)
  const clear = useDataSourcesStore((s) => s.clearImportOutcome)
  if (outcome === null) return null

  if (outcome.status === 'ok') {
    return (
      <Alert data-testid="import-report">
        <AlertTitle>Import complete</AlertTitle>
        <AlertDescription>
          <p>
            {outcome.report.createdCompounds} new compound identity record
            {outcome.report.createdCompounds === 1 ? '' : 's'} and{' '}
            {outcome.report.createdObservations} new measurement record
            {outcome.report.createdObservations === 1 ? '' : 's'} stored.
          </p>
          {outcome.report.skippedCompounds + outcome.report.skippedObservations > 0 && (
            <p>
              {outcome.report.skippedCompounds + outcome.report.skippedObservations} record
              {outcome.report.skippedCompounds + outcome.report.skippedObservations === 1
                ? ' was'
                : 's were'}{' '}
              skipped because they are already stored (existing records win — nothing was
              overwritten).
            </p>
          )}
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="mt-2"
            data-testid="dismiss-import-report"
            onClick={clear}
          >
            Dismiss
          </Button>
        </AlertDescription>
      </Alert>
    )
  }

  if (outcome.status === 'rejected') {
    return (
      <Alert variant="destructive" data-testid="import-report">
        <AlertTitle>Import rejected — nothing was written</AlertTitle>
        <AlertDescription>
          <ul className="list-disc pl-4">
            {outcome.errors.map((error, index) => (
              <li key={index}>
                {error.code}
                {error.path !== undefined ? ` at ${error.path}` : ''}: {error.message}
              </li>
            ))}
          </ul>
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <Alert variant="destructive" data-testid="import-report">
      <AlertTitle>Import failed — nothing was written</AlertTitle>
      <AlertDescription>
        {outcome.message}
        <div className="mt-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            data-testid="dismiss-import-report"
            onClick={clear}
          >
            Dismiss
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  )
}

export function DataSourcesView() {
  const hydrateStored = useDataSourcesStore((s) => s.hydrateStored)
  const storedStatus = useDataSourcesStore((s) => s.stored.status)

  // Mount only re-reads local storage — no network, no seeding.
  useEffect(() => {
    if (storedStatus === 'idle') void hydrateStored()
  }, [hydrateStored, storedStatus])

  return (
    <div className="space-y-6" data-testid="data-sources-view">
      <SourceSearchCard />
      <SearchResultsCard />
      <MeasurementsCard />
      <ImportCard />
      <StoredDataPanel />
    </div>
  )
}
