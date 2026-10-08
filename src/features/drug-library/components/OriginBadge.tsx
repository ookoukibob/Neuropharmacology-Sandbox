/**
 * Storage-origin badge — deliberately distinct from provenance badges.
 *
 * Origin says *where the record lives in storage* (who created the row);
 * provenance says *how a single scientific value came to exist*. The two
 * are never conflated: importing a record does not rewrite provenance, and
 * a user-entered value is never labeled "literature" because the record
 * was imported.
 */
import { Badge } from '@/components/ui/badge'
import type { DrugOrigin } from '@/domain/drug/drug'

const ORIGIN_LABELS: Record<DrugOrigin, string> = {
  'built-in-demo': 'Demo example',
  user: 'Entered by you',
  imported: 'Imported',
}

export function OriginBadge({ origin }: { origin: DrugOrigin }) {
  return (
    <Badge variant={origin === 'built-in-demo' ? 'secondary' : 'default'} data-testid="origin-badge">
      {ORIGIN_LABELS[origin]}
    </Badge>
  )
}
