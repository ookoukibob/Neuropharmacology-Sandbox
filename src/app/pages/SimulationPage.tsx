import { PageHeader } from '@/app/layout/PageHeader'
import { scenarioRepository } from '@/app/scenarioRepository'
import { SimulationView } from '@/features/simulation'

/**
 * Simulation scenario editor: enter explicit model parameters, time horizon
 * and dosing events, then inspect the computed results and numerical
 * diagnostics. Drafts can be saved as named scenarios.
 */
export function SimulationPage() {
  return (
    <PageHeader
      title="Simulation"
      description="Enter your model parameters, time horizon and dosing events to run the dynamic pharmacokinetic simulation. Save, load and manage named scenarios; results are mathematical model output, not clinical predictions."
    >
      <SimulationView scenarioRepository={scenarioRepository} />
    </PageHeader>
  )
}
