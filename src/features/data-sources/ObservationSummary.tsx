/**
 * Shared rendering of one experimental observation (Layer B row): value
 * with its reported qualifier, endpoint and parameter mapping, the
 * measurement context that the source actually supplied (missing context
 * stays missing), and the mandatory provenance line with the source
 * record link, retrieval date and license.
 */
import { Badge } from '@/components/ui/badge'
import type { RemoteObservation } from '../../domain/sources/observation'

/** Value with its reported qualifier preserved ('<' stays '<'). */
function formatObservationValue(observation: RemoteObservation): string {
  const relation = observation.qualifier === '=' ? '' : `${observation.qualifier ?? ''} `
  return `${relation}${observation.value}${observation.unit === undefined ? '' : ` ${observation.unit}`}`
}

export function ObservationSummary({ observation }: { readonly observation: RemoteObservation }) {
  const assay = observation.assay
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <p className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{observation.endpoint}</Badge>
        <span className="font-medium">{formatObservationValue(observation)}</span>
        <span className="text-muted-foreground">
          {observation.compoundName ?? observation.compoundSourceId} ›{' '}
          {observation.target.name ?? 'target not named'}
        </span>
        {observation.parameterKind !== undefined ? (
          <Badge variant="outline">maps to {observation.parameterKind.toUpperCase()}</Badge>
        ) : (
          <Badge variant="outline">no parameter mapping</Badge>
        )}
      </p>
      <p className="break-words text-xs text-muted-foreground">
        {[
          observation.species !== undefined ? `species ${observation.species}` : null,
          observation.target.organism !== undefined && observation.target.organism !== observation.species
            ? `target organism ${observation.target.organism}`
            : null,
          assay?.assayId !== undefined ? `assay ${assay.assayId}` : null,
          assay?.description ?? null,
          observation.activityComment ?? null,
        ]
          .filter((part): part is string => part !== null && part.length > 0)
          .join(' · ')}
      </p>
      <p className="break-words text-xs text-muted-foreground">
        Source:{' '}
        <a
          href={observation.provenance.url}
          target="_blank"
          rel="noreferrer noopener"
          className="underline underline-offset-2"
        >
          {observation.provenance.sourceName} record {observation.provenance.recordId}
        </a>{' '}
        · retrieved {observation.provenance.retrievedAt.slice(0, 10)}
        {observation.provenance.licenseNotice !== undefined
          ? ` · ${observation.provenance.licenseNotice}`
          : ''}
      </p>
    </div>
  )
}
