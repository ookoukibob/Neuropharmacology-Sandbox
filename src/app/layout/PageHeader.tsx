import type { ReactNode } from 'react'

interface PageHeaderProps {
  readonly title: string
  readonly description: string
  readonly children?: ReactNode
}

/** Standard page scaffold: title, description, content. */
export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>

      {children}
    </div>
  )
}
