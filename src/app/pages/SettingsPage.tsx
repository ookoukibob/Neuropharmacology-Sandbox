import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeftRight, RotateCcw } from 'lucide-react'
import { PageHeader } from '@/app/layout/PageHeader'
import { usePreferencesStore } from '@/app/preferencesStore'
import { MODELS, type ModelId } from '@/engine'
import {
  crossRangeError,
  rangeFieldError,
  type RangeField,
  type ThemePreference,
} from '@/features/preferences'
import type { CurveSettings, RangeDraft } from '@/features/calculator/store'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from 'cn'
import packageMetadata from '../../../package.json'

/**
 * Settings (phase 9B): device-local presentation preferences with real
 * behaviour behind every control.
 *
 * - Appearance: theme preference (system/light/dark) applied immediately
 *   and persisted (§ features/preferences/theme.ts writes the `.dark` class).
 * - Calculator display defaults: the per-model curve range/points and
 *   axis scales each model starts with. These are chart presentation
 *   defaults — scientific input drafts, calculation results and drug
 *   records are never persisted here, and invalid text is refused with a
 *   field message instead of being saved.
 * - Data management: links to the existing Import / Export page (Import,
 *   Export and Recovery tabs) — nothing is duplicated here.
 * - Reset: restores theme and calculator display defaults only, through
 *   the same two-step acknowledgement the app uses elsewhere.
 */

const MODEL_IDS: readonly ModelId[] = Object.values(MODELS).map(
  (descriptor) => descriptor.id,
)

const THEME_OPTIONS: readonly ThemePreference[] = ['system', 'light', 'dark']
const THEME_LABELS: Record<ThemePreference, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
}

const REPOSITORY_URL = 'https://github.com/ookoukibob/Neuropharmacology-Sandbox'

interface ModelErrors {
  readonly min: string | null
  readonly max: string | null
  readonly points: string | null
  readonly cross: string | null
}

const NO_ERRORS: ModelErrors = { min: null, max: null, points: null, cross: null }

function emptyModelErrors(): Record<ModelId, ModelErrors> {
  return {
    'pk.first-order-one-compartment': NO_ERRORS,
    'occupancy.single-site': NO_ERRORS,
    'dose-response.hill': NO_ERRORS,
  }
}

/** Fresh range drafts from the persisted defaults (never shared refs). */
function rangesOf(settings: Record<ModelId, CurveSettings>): Record<ModelId, RangeDraft> {
  const rangeOf = (model: ModelId): RangeDraft => {
    const range = settings[model].range
    return { min: range.min, max: range.max, points: range.points }
  }
  return {
    'pk.first-order-one-compartment': rangeOf('pk.first-order-one-compartment'),
    'occupancy.single-site': rangeOf('occupancy.single-site'),
    'dose-response.hill': rangeOf('dose-response.hill'),
  }
}

function ScaleGroup(props: {
  readonly legend: string
  readonly name: string
  readonly value: 'linear' | 'log'
  readonly onChange: (scale: 'linear' | 'log') => void
  readonly describedBy: string | undefined
  readonly testIdPrefix: string
}) {
  return (
    <fieldset className="flex items-end gap-2">
      <legend className="text-xs text-muted-foreground">{props.legend}</legend>
      <div className="flex gap-2">
        {(['linear', 'log'] as const).map((scale) => (
          <label key={scale} className="inline-flex items-center gap-1">
            <input
              type="radio"
              name={props.name}
              value={scale}
              checked={props.value === scale}
              onChange={() => props.onChange(scale)}
              className="peer sr-only"
              aria-describedby={props.describedBy}
              data-testid={`${props.testIdPrefix}-${scale}`}
            />
            <span
              className={cn(
                'px-2 py-1 text-xs rounded border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
                props.value === scale
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-input hover:bg-muted',
              )}
            >
              {scale}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function RangeInput(props: {
  readonly id: string
  readonly label: string
  readonly value: string
  readonly inputMode?: 'decimal' | 'numeric'
  readonly onChange: (text: string) => void
  readonly error: string | null
  readonly describedBy: string | undefined
  readonly testId: string
}) {
  const errorId = `${props.id}-error`
  return (
    <div className="grid min-w-32 gap-1.5">
      <Label htmlFor={props.id} className="text-xs text-muted-foreground">
        {props.label}
      </Label>
      <Input
        id={props.id}
        type="text"
        value={props.value}
        inputMode={props.inputMode}
        onChange={(event) => props.onChange(event.target.value)}
        aria-invalid={props.error !== null}
        aria-describedby={props.error !== null ? errorId : props.describedBy}
        data-testid={props.testId}
      />
      {props.error !== null && (
        <p id={errorId} className="text-xs text-destructive">
          {props.error}
        </p>
      )}
    </div>
  )
}

export function SettingsPage() {
  const theme = usePreferencesStore((state) => state.theme)
  const settings = usePreferencesStore((state) => state.calculatorSettings)
  const loadStatus = usePreferencesStore((state) => state.loadStatus)
  const setTheme = usePreferencesStore((state) => state.setTheme)
  const setCalculatorSettings = usePreferencesStore(
    (state) => state.setCalculatorSettings,
  )
  const resetCalculatorSettings = usePreferencesStore(
    (state) => state.resetCalculatorSettings,
  )
  const resetPreferences = usePreferencesStore((state) => state.resetPreferences)

  // The range inputs keep keystrokes in component state (ADR-3): the store
  // only ever receives validated values, while invalid text stays visible
  // next to its message instead of being silently reverted or persisted.
  const [rangeDrafts, setRangeDrafts] = useState<Record<ModelId, RangeDraft>>(() =>
    rangesOf(settings),
  )
  const [modelErrors, setModelErrors] = useState<Record<ModelId, ModelErrors>>(
    emptyModelErrors,
  )
  const [confirmingReset, setConfirmingReset] = useState(false)
  const wasConfirming = useRef(false)
  const [resetDone, setResetDone] = useState(false)
  const [restoreDone, setRestoreDone] = useState(false)

  // Focus follows the reset acknowledgement exactly like the delete flow:
  // into the confirmation when it opens, back to the reset button when it
  // closes — never on first render, so nothing is stolen on load.
  useEffect(() => {
    if (confirmingReset) {
      document.getElementById('settings-reset-confirm')?.focus()
    } else if (wasConfirming.current) {
      document.getElementById('settings-reset')?.focus()
    }
    wasConfirming.current = confirmingReset
  }, [confirmingReset])

  const syncDraftsFromStore = (): void => {
    setRangeDrafts(rangesOf(usePreferencesStore.getState().calculatorSettings))
    setModelErrors(emptyModelErrors())
  }

  /** Validate a candidate; store it (persisting) only when every rule passes. */
  const commitSettings = (model: ModelId, candidate: CurveSettings): void => {
    const fields = {
      min: rangeFieldError('min', candidate.range.min),
      max: rangeFieldError('max', candidate.range.max),
      points: rangeFieldError('points', candidate.range.points),
    }
    const fieldsClear =
      fields.min === null && fields.max === null && fields.points === null
    const cross = fieldsClear ? crossRangeError(candidate) : null
    const nextErrors: Record<ModelId, ModelErrors> = {
      ...modelErrors,
      [model]: { ...fields, cross },
    }
    setModelErrors(nextErrors)
    if (fieldsClear && cross === null) {
      setCalculatorSettings(model, candidate)
    }
  }

  const handleRangeChange = (
    model: ModelId,
    field: RangeField,
    text: string,
  ): void => {
    const nextRange: RangeDraft = { ...rangeDrafts[model], [field]: text }
    const nextDrafts: Record<ModelId, RangeDraft> = {
      ...rangeDrafts,
      [model]: nextRange,
    }
    setRangeDrafts(nextDrafts)
    commitSettings(model, { ...settings[model], range: nextRange })
  }

  const handleScaleChange = (
    model: ModelId,
    axis: 'x' | 'y',
    scale: 'linear' | 'log',
  ): void => {
    const current = settings[model]
    const candidate: CurveSettings =
      axis === 'x' ? { ...current, xScale: scale } : { ...current, yScale: scale }
    commitSettings(model, candidate)
  }

  const crossErrorId = (model: ModelId): string => `pref-${model}-range-cross-error`

  return (
    <PageHeader
      title="Settings"
      description="Appearance and calculator display defaults are stored on this device only. Scientific data — drug records, imports, backups — is managed in the Drug Library and on the Import / Export page."
    >
      <div className="flex flex-col gap-6" data-testid="settings-view">
        {loadStatus === 'invalid' && (
          <p
            role="status"
            data-testid="preferences-invalid-note"
            className="text-sm text-muted-foreground"
          >
            Saved preferences couldn&apos;t be read, so the application defaults are
            in use.
          </p>
        )}
        {loadStatus === 'unavailable' && (
          <p
            role="status"
            data-testid="preferences-unavailable-note"
            className="text-sm text-muted-foreground"
          >
            Browser storage is unavailable — preference changes won&apos;t survive a
            reload.
          </p>
        )}

        {/* 1. Appearance */}
        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>Appearance</CardTitle>
            <CardDescription>
              Stored on this device and applied immediately.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <fieldset className="flex flex-col gap-2">
              <legend className="text-sm font-medium">Theme</legend>
              <div className="flex gap-2">
                {THEME_OPTIONS.map((option) => (
                  <label key={option} className="inline-flex items-center gap-1">
                    <input
                      type="radio"
                      name="settings-theme"
                      value={option}
                      checked={theme === option}
                      onChange={() => setTheme(option)}
                      className="peer sr-only"
                      data-testid={`theme-${option}`}
                    />
                    <span
                      className={cn(
                        'px-2 py-1 text-xs rounded border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring',
                        theme === option
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-input hover:bg-muted',
                      )}
                    >
                      {THEME_LABELS[option]}
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                System follows your operating system&apos;s light or dark preference,
                including changes made while the application is open.
              </p>
            </fieldset>
          </CardContent>
        </Card>

        {/* 2. Calculator display defaults */}
        <Card>
          <CardHeader>
            <CardAction>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  resetCalculatorSettings()
                  syncDraftsFromStore()
                  setRestoreDone(true)
                }}
                data-testid="restore-calculator-defaults"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                Restore application defaults
              </Button>
            </CardAction>
            <CardTitle headingLevel={2}>Calculator display defaults</CardTitle>
            <CardDescription>
              The curve range and axis scales each model starts with. These are
              chart presentation defaults — parameter inputs, results and drug
              records are never stored here.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {restoreDone && (
              <p
                role="status"
                data-testid="calculator-defaults-restored"
                className="text-sm text-muted-foreground"
              >
                Calculator display defaults were restored to the application
                defaults.
              </p>
            )}
            {MODEL_IDS.map((model) => {
              const errors = modelErrors[model]
              const crossId = crossErrorId(model)
              const crossDescribedBy =
                errors.cross !== null ? crossId : undefined
              return (
                <div
                  key={model}
                  className="space-y-3 rounded-md border p-3"
                  data-testid={`settings-model-${model}`}
                >
                  <h3 className="text-sm font-medium">{MODELS[model].label}</h3>
                  <div className="flex flex-wrap items-end gap-4">
                    <RangeInput
                      id={`pref-${model}-min`}
                      label="Range min"
                      value={rangeDrafts[model].min}
                      inputMode="decimal"
                      onChange={(text) => handleRangeChange(model, 'min', text)}
                      error={errors.min}
                      describedBy={
                        errors.min !== null
                          ? undefined
                          : crossDescribedBy
                      }
                      testId={`pref-range-min-${model}`}
                    />
                    <RangeInput
                      id={`pref-${model}-max`}
                      label="Range max"
                      value={rangeDrafts[model].max}
                      inputMode="decimal"
                      onChange={(text) => handleRangeChange(model, 'max', text)}
                      error={errors.max}
                      describedBy={
                        errors.max !== null
                          ? undefined
                          : crossDescribedBy
                      }
                      testId={`pref-range-max-${model}`}
                    />
                    <RangeInput
                      id={`pref-${model}-points`}
                      label="Points (blank = 200)"
                      value={rangeDrafts[model].points}
                      inputMode="numeric"
                      onChange={(text) => handleRangeChange(model, 'points', text)}
                      error={errors.points}
                      describedBy={
                        errors.points !== null
                          ? undefined
                          : crossDescribedBy
                      }
                      testId={`pref-range-points-${model}`}
                    />
                  </div>
                  <div className="flex flex-wrap items-end gap-4">
                    <ScaleGroup
                      legend="X axis"
                      name={`pref-x-scale-${model}`}
                      value={settings[model].xScale}
                      onChange={(scale) => handleScaleChange(model, 'x', scale)}
                      describedBy={crossDescribedBy}
                      testIdPrefix={`pref-x-scale-${model}`}
                    />
                    <ScaleGroup
                      legend="Y axis"
                      name={`pref-y-scale-${model}`}
                      value={settings[model].yScale}
                      onChange={(scale) => handleScaleChange(model, 'y', scale)}
                      describedBy={crossDescribedBy}
                      testIdPrefix={`pref-y-scale-${model}`}
                    />
                  </div>
                  {errors.cross !== null && (
                    <p id={crossId} className="text-xs text-destructive">
                      {errors.cross}
                    </p>
                  )}
                </div>
              )
            })}
          </CardContent>
        </Card>

        {/* 3. Data management and recovery */}
        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>Data management and recovery</CardTitle>
            <CardDescription>
              Import, export and full recovery backups live on the Import / Export
              page — its Import, Export and Recovery tabs. Resetting application
              preferences never deletes or changes that data.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline" data-testid="settings-import-export-link">
              <Link to="/import-export">
                <ArrowLeftRight aria-hidden="true" className="size-4" />
                Open Import / Export
              </Link>
            </Button>
          </CardContent>
        </Card>

        {/* 4. About and scientific scope */}
        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>About and scientific scope</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <p data-testid="about-name">
              <span className="font-medium">Neuropharmacology Sandbox</span> —{' '}
              {packageMetadata.description}
            </p>
            <p className="text-muted-foreground" data-testid="about-version">
              Version {packageMetadata.version} · License {packageMetadata.license}
            </p>
            <p>
              Calculations depend on the selected model and the parameters you
              supply: every result shows its formula, inputs, trace and
              assumptions so it can be checked. The project makes no unsupported
              pharmacological claims and is not a clinical decision-support
              system.
            </p>
            <p>
              <a
                href={REPOSITORY_URL}
                className="underline underline-offset-4 hover:text-foreground"
                data-testid="about-repository-link"
              >
                Project repository and documentation
              </a>
            </p>
          </CardContent>
        </Card>

        {/* Reset preferences (scope: theme + calculator display defaults) */}
        <Card>
          <CardHeader>
            <CardTitle headingLevel={2}>Reset application preferences</CardTitle>
            <CardDescription>
              Restores the theme and the calculator display defaults on this device
              to the application defaults. It does not delete or reset drug
              records, imported libraries, backups, exports or calculation
              results.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {resetDone && (
              <p
                role="status"
                data-testid="preferences-reset-done"
                className="mb-2 text-sm text-muted-foreground"
              >
                Preferences were reset to their defaults. Drug records, imports,
                backups and calculation results were not changed.
              </p>
            )}
            {confirmingReset ? (
              <div
                className="flex flex-wrap items-center gap-2"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') setConfirmingReset(false)
                }}
              >
                <p
                  id="settings-reset-confirm-text"
                  className="text-sm text-destructive"
                  data-testid="settings-reset-confirm-text"
                >
                  Reset the appearance theme and calculator display defaults to
                  their original values?
                </p>
                <Button
                  id="settings-reset-confirm"
                  data-testid="settings-reset-confirm"
                  aria-describedby="settings-reset-confirm-text"
                  onClick={() => {
                    resetPreferences()
                    syncDraftsFromStore()
                    setConfirmingReset(false)
                    setResetDone(true)
                  }}
                >
                  <RotateCcw aria-hidden="true" className="size-4" />
                  Confirm reset
                </Button>
                <Button
                  variant="outline"
                  id="settings-reset-cancel"
                  data-testid="settings-reset-cancel"
                  onClick={() => setConfirmingReset(false)}
                >
                  Cancel
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                id="settings-reset"
                data-testid="settings-reset"
                onClick={() => setConfirmingReset(true)}
              >
                <RotateCcw aria-hidden="true" className="size-4" />
                Reset application preferences
              </Button>
            )}
          </CardContent>
        </Card>
      </div>
    </PageHeader>
  )
}
