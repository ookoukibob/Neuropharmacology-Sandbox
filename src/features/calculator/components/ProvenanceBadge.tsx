/**
 * Provenance display badge — shared component for calculator and drug library.
 * Provenance is shown as a whole discriminated unit, never flattened into
 * a bare number or a "verified" flag. The title attribute carries the
 * details (source, model, recorded-at) for hover/AT without inventing
 * confidence the data does not have.
 */
import { Badge } from '@/components/ui/badge'
import type { Provenance } from '@/domain/provenance/provenance'

function labelOf(provenance: Provenance): string {
  switch (provenance.type) {
    case 'literature':
      return 'Literature'
    case 'user':
      return 'User-entered'
    case 'calculated':
      return 'Calculated'
    case 'derived':
      return 'Derived'
    case 'unknown':
      return 'Unknown origin'
  }
}

function detailOf(provenance: Provenance): string {
  switch (provenance.type) {
    case 'literature': {
      const parts = [`Source: ${provenance.source}`]
      if (provenance.citation !== undefined) parts.push(provenance.citation)
      if (provenance.doi !== undefined) parts.push(`DOI: ${provenance.doi}`)
      if (provenance.url !== undefined) parts.push(provenance.url)
      if (provenance.accessedAt !== undefined) parts.push(`Accessed: ${provenance.accessedAt}`)
      return parts.join(' · ')
    }
    case 'user':
      return provenance.recordedAt !== undefined
        ? `Recorded by the user at ${provenance.recordedAt}`
        : 'Recorded by the user'
    case 'calculated':
      return `Calculated by model "${provenance.model}" at ${provenance.recordedAt}`
    case 'derived':
      return `Derived at ${provenance.recordedAt} from: ${provenance.from.join(', ')}`
    case 'unknown':
      return 'No provenance information was declared for this value.'
  }
}

export function ProvenanceBadge({ provenance }: { provenance: Provenance }) {
  return (
    <Badge variant="outline" title={detailOf(provenance)} data-testid="provenance-badge">
      {labelOf(provenance)}
    </Badge>
  )
}