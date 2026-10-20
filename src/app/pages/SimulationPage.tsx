import { PageHeader } from '@/app/layout/PageHeader'
import { scenarioRepository } from '@/app/scenarioRepository'
import { SimulationView } from '@/features/simulation'

/**
 * Simulation demonstration: run one explicit synthetic two-compartment IV
 * scenario through the Phase 41 engine and inspect the results, dosing
 * events and numerical diagnostics. Drafts can be saved as named scenarios.
 */
export function SimulationPage() {
  return (
    <PageHeader
      title="Simulation"
      description="Run a synthetic demonstration through the dynamic pharmacokinetic engine and inspect concentrations, amounts, dosing events and numerical diagnostics. Save, load and manage named scenarios; results are mathematical model output, not clinical predictions."
    >
      <SimulationView scenarioRepository={scenarioRepository} />
    </PageHeader>
  )
}
