import { useCallback, useRef, useState } from 'react'
import { simulate } from '@/engine/simulation/simulate'
import type { SimulationError, SimulationResult, SimulationScenario } from '@/engine/simulation/types'

/**
 * Session state of one demonstration run (phase 42).
 *
 * Deliberately ephemeral: component state only. Nothing is persisted, cached
 * across reloads, or written to IndexedDB — the simulation demonstration is a
 * transient calculation like the scalar calculator, not library data.
 *
 * Stale results: starting a new run clears the previous result immediately,
 * and a failed run leaves no result at all. A previous run is therefore never
 * displayed as if it were the outcome of the current one.
 */
export type SimulationRunState =
  | { readonly status: 'idle' }
  | {
      readonly status: 'success'
      readonly result: SimulationResult
      /** Number of completed runs, so a rerun is visibly a new attempt. */
      readonly runNumber: number
    }
  | {
      readonly status: 'failure'
      readonly errors: readonly SimulationError[]
      readonly runNumber: number
    }

export interface SimulationRunner {
  readonly state: SimulationRunState
  /** Run `simulate()` for the given scenario. Never throws for user input. */
  run: (scenario: SimulationScenario) => void
}

export function useSimulationRunner(): SimulationRunner {
  const [state, setState] = useState<SimulationRunState>({ status: 'idle' })
  const runs = useRef(0)

  const run = useCallback((scenario: SimulationScenario) => {
    runs.current += 1
    const runNumber = runs.current
    // Clear any previous outcome before computing: a stale chart must never
    // stand in for the result of the run the user just started.
    setState({ status: 'idle' })
    const report = simulate(scenario)
    if (report.ok) {
      setState({ status: 'success', result: report.result, runNumber })
    } else {
      setState({ status: 'failure', errors: report.errors, runNumber })
    }
  }, [])

  return { state, run }
}
