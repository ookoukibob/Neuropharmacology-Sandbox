import { PageHeader } from '@/app/layout/PageHeader'
import { SimulationView } from '@/features/simulation'

/**
 * Simulation demonstration: run one explicit synthetic two-compartment IV
 * scenario through the Phase 41 engine and inspect the results, dosing
 * events and numerical diagnostics. No scenario editing or persistence yet.
 */
export function SimulationPage() {
  return (
    <PageHeader
      title="Simulation"
      description="Run a synthetic demonstration through the dynamic pharmacokinetic engine and inspect concentrations, amounts, dosing events and numerical diagnostics. Results are mathematical model output, not clinical predictions."
    >
      <SimulationView />
    </PageHeader>
  )
}
