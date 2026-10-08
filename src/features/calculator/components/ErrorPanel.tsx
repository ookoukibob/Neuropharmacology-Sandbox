/**
 * ErrorPanel — renders a list of calculation errors (field-mapped or global)
 * in a destructive alert. Used for both scalar and curve errors.
 */
import { AlertCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import type { CalculationError } from '@/engine/types'

interface ErrorPanelProps {
  readonly title: string
  readonly errors: readonly CalculationError[]
  readonly testId?: string
}

export function ErrorPanel({ title, errors, testId }: ErrorPanelProps) {
  if (errors.length === 0) return null

  return (
    <Alert variant="destructive" data-testid={testId}>
      <AlertCircle className="size-4" aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4 space-y-1">
          {errors.map((e, i) => (
            <li key={i} className="text-sm">
              {e.message}
              {e.parameter && <span className="text-muted-foreground ml-1 font-mono">({e.parameter})</span>}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  )
}