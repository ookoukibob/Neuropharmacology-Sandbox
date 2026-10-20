import { useCallback, useRef, useState } from 'react'
import { simulate } from '@/engine/simulation/simulate'
import type { SimulationError, SimulationResult, SimulationScenario } from '@/engine/simulation/types'

/**
 * Session state of one simulation run.
 *
 * Deliberately ephemeral: component state only. Nothing is persisted, cached
 * across reloads, or written to IndexedDB — a simulation is a transient
 * calculation like the scalar calculator, not library data.
 *
 * Stale results (phase 43): `clear()` discards the previous outcome. The
 * scenario editor calls it whenever the draft changes, so a chart on screen
 * always belongs to the draft that produced it. Starting a run also clears the
 * previous outcome before computing.
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
  /** Discard the current outcome (editing the draft makes it stale). */
  clear: () => void
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

  const clear = useCallback(() => {
    setState({ status: 'idle' })
  }, [])

  return { state, run, clear }
}
