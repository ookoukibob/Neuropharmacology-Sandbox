import { Info } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { ReactNode } from 'react'

interface PageHeaderProps {
  readonly title: string
  readonly description: string
  readonly children?: ReactNode
}

/** Standard page scaffold: title, description, content, phase notice. */
export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      <Alert>
        <Info className="size-4" aria-hidden="true" />
        <AlertTitle>Foundation phase</AlertTitle>
        <AlertDescription>
          This view is a placeholder. The current phase establishes the
          technical foundation: architecture, domain models, schemas and test
          strategy. Feature implementation follows the roadmap in
          docs/architecture.md.
        </AlertDescription>
      </Alert>

      {children}
    </div>
  )
}
