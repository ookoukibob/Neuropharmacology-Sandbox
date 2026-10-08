/**
 * CalculatorView — the main calculator UI (phase 4).
 *
 * Layout:
 * - Model selector (populated from engine registry)
 * - Left panel: input form with fields driven by model adapter specs
 * - Right panel: result / error / empty state
 * - Full-width: CalculationTrace (when result exists)
 * - Full-width: VisualizationPanel (curve controls + chart)
 */
import { useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Calculator, Database } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { MODELS } from '@/engine'
import { useLibraryStore } from '@/app/libraryStore'
import { useCalculatorStore } from '@/app/calculatorStore'
import {
  type LibraryCandidate,
  modelGroups,
  getDraftField,
  getVisibleSpecs,
  getFieldCandidates,
  getXUnitHint,
} from './modelAdapters'
import { ParameterField } from './components/ParameterField'
import { ResultPanel } from './components/ResultPanel'
import { CalculationTrace } from './components/CalculationTrace'
import { VisualizationPanel } from './components/VisualizationPanel'
import { ErrorPanel } from './components/ErrorPanel'
import type { ModelId } from '@/engine/types'

export function CalculatorView() {
  const [searchParams, setSearchParams] = useSearchParams()
  const {
    draft,
    setModel,
    setDraftField,
    setPKMode,
    loadFromLibrary,
    setRange,
    setXScale,
    setYScale,
    applyCurveSettings,
    calculate,
    resetInputs,
    applyUrlParams,
    stale,
    curveSettingsStale,
    report,
    fieldErrors,
    globalErrors,
    draftIssues,
    curve,
    curveErrors,
    settings,
    drugId,
  } = useCalculatorStore()

  const { drugs } = useLibraryStore()
  const drug = drugId ? drugs.find((d) => d.id === drugId) : undefined

  // Sync URL params on mount
  useEffect(() => {
    applyUrlParams({
      model: searchParams.get('model'),
      drug: searchParams.get('drug'),
    })
  }, [searchParams, applyUrlParams])

  // Sync model/drug changes to URL
  useEffect(() => {
    const next = new URLSearchParams(searchParams)
    let changed = false
    if (next.get('model') !== draft.model) {
      next.set('model', draft.model)
      changed = true
    }
    if (next.get('drug') !== drugId) {
      if (drugId) next.set('drug', drugId)
      else next.delete('drug')
      changed = true
    }
    if (changed) setSearchParams(next, { replace: true })
  }, [draft.model, drugId, searchParams, setSearchParams])

  const model = draft.model
  const specs = getVisibleSpecs(draft)

  // Handle PK mode toggle
  const isPK = model === 'pk.first-order-one-compartment'

  // Handle field changes
  const handleValueChange = (key: string, value: string) => {
    setDraftField(key, { value })
  }

  const handleUnitChange = (key: string, unit: string) => {
    setDraftField(key, { unit })
  }

  const handleLoad = (key: string, candidate: LibraryCandidate) => {
    loadFromLibrary(key, candidate)
  }

  // PK mode change
  const handleModeChange = (mode: 'halfLife' | 'k') => {
    if (!isPK) return
    setPKMode(mode)
  }

  // Range change
  const handleRangeChange = (patch: Partial<typeof settings[typeof model]['range']>) => {
    setRange(patch)
  }

  // X unit hint for range inputs
  const xUnitHint = getXUnitHint(draft)

  // Current model's settings
  const currentSettings = settings[model as ModelId]

  // Field errors from engine (mapped)
  const getFieldError = (key: string) => fieldErrors[key]

  // Candidates for each field
  const getCandidates = (key: string): LibraryCandidate[] => {
    return [...getFieldCandidates(draft, key, drug)]
  }

  return (
    <div className="space-y-6" data-testid="calculator-view">
      {/* Model selector */}
      <Card>
        <CardContent className="pt-0">
          <div className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="model-select" className="text-sm font-medium">
                Model
              </Label>
              <select
                id="model-select"
                className="h-9 rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={model}
                onChange={(e) => setModel(e.target.value as ModelId)}
                data-testid="model-select"
              >
                {modelGroups().map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>

            <p className="text-sm text-muted-foreground font-mono">{MODELS[model as ModelId].formula}</p>

            {/* PK mode toggle */}
            {isPK && (
              <div className="flex items-center gap-2" data-testid="pk-mode-toggle">
                <Label className="text-sm font-medium">Parameterization</Label>
                <div className="flex gap-1 bg-muted rounded p-1" role="radiogroup" aria-label="PK parameterization">
                  {(['halfLife', 'k'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      role="radio"
                      aria-checked={draft.mode === m}
                      onClick={() => handleModeChange(m)}
                      className={`px-3 py-1.5 text-sm rounded transition-colors ${
                        draft.mode === m
                          ? 'bg-background text-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                      data-testid={`pk-mode-${m}`}
                    >
                      {m === 'halfLife' ? 'Half-life (t½)' : 'Rate constant (k)'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Drug context indicator */}
            {drugId && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Database className="size-4" aria-hidden="true" />
                <span>
                  Using parameters from: <strong>{drug?.identifiers.name ?? drugId}</strong>
                </span>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Main layout: Inputs | Result */}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Inputs panel */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Calculator className="size-4" aria-hidden="true" />
              Inputs
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {specs.map((spec) => {
              const field = getDraftField(draft, spec.key)
              return (
                <ParameterField
                  key={spec.key}
                  spec={spec}
                  field={field}
                  error={getFieldError(spec.key)}
                  candidates={getCandidates(spec.key)}
                  onValueChange={(v) => handleValueChange(spec.key, v)}
                  onUnitChange={(u) => handleUnitChange(spec.key, u)}
                  onLoad={(c) => handleLoad(spec.key, c)}
                  idPrefix="calc"
                />
              )
            })}

            {/* Zod structural errors */}
            {draftIssues.length > 0 && (
              <ErrorPanel
                title="Fix the inputs"
                errors={draftIssues.map((m) => ({ code: 'MISSING_PARAMETER', message: m, parameter: '' }))}
                testId="zod-errors"
              />
            )}

            {/* Global engine errors (no field) */}
            {globalErrors.length > 0 && (
              <ErrorPanel
                title="Calculation unavailable"
                errors={globalErrors.map((m) => ({ code: 'MODEL_NOT_APPLICABLE', message: m }))}
                testId="global-errors"
              />
            )}

            {/* Calculate / Reset buttons */}
            <div className="flex gap-2 pt-2">
              <Button onClick={calculate} data-testid="calculate-btn">
                Calculate
              </Button>
              <Button variant="outline" onClick={resetInputs} data-testid="reset-btn">
                Reset inputs
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Result panel */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Result</CardTitle>
          </CardHeader>
          <CardContent className="min-h-[300px]">
            {report?.ok ? (
              <ResultPanel result={report.result} stale={stale} />
            ) : report?.ok === false ? (
              <ErrorPanel title="Calculation unavailable" errors={report.errors} testId="calculation-errors" />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
                <Calculator className="size-12 mb-4 opacity-50" aria-hidden="true" />
                <p>Enter explicit inputs and click Calculate.</p>
                <p className="text-xs mt-1">
                  No defaults are applied — every parameter must be supplied.
                </p>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Calculation Trace */}
      {report?.ok && (
        <Card>
          <CardContent className="pt-0">
            <CalculationTrace trace={report.result.trace} />
          </CardContent>
        </Card>
      )}

      {/* Visualization */}
      <Card>
        <CardContent className="pt-0">
          <VisualizationPanel
            curve={curve}
            curveErrors={curveErrors}
            settings={currentSettings}
            hasValidReport={report?.ok === true}
            curveSettingsStale={curveSettingsStale}
            onRangeChange={handleRangeChange}
            onXScaleChange={setXScale}
            onYScaleChange={setYScale}
            onApply={applyCurveSettings}
            xUnitHint={xUnitHint}
          />
        </CardContent>
      </Card>
    </div>
  )
}