import { Link } from 'react-router-dom'
import { PageHeader } from '@/app/layout/PageHeader'

export function NotFoundPage() {
  return (
    <PageHeader title="Page not found" description="The requested view does not exist.">
      <Link
        to="/library"
        className="text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Return to the drug library
      </Link>
    </PageHeader>
  )
}
