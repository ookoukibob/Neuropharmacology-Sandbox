import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * End-to-end proof for the static guard: the rule is loaded by the real
 * oxlint binary through the same JSON plugin format the repository config
 * uses, and it is pointed at the two fixtures.
 *
 * The fixtures have to live under `src/` while they are linted — that is the
 * scope the rule protects — so each case is copied to a throwaway probe file
 * and removed afterwards. The probe is also gitignored in case a run is killed.
 */
const repoRoot = path.resolve(import.meta.dirname, '../..')
const oxlintBin = path.join(repoRoot, 'node_modules', 'oxlint', 'bin', 'oxlint')
const configPath = path.join(repoRoot, 'scripts', 'notation-lint', 'oxlint.json')
const fixtures = path.join(repoRoot, 'scripts', 'notation-lint', 'fixtures')

const probes = [
  { source: path.join(fixtures, 'raw-notation.tsx'), target: path.join(repoRoot, 'src/features/__notation-lint-raw-probe.tsx') },
  { source: path.join(fixtures, 'clean.tsx'), target: path.join(repoRoot, 'src/features/__notation-lint-clean-probe.tsx') },
]

/** Lint one file with the notation rule only; returns the parsed findings. */
function lintProbe(target) {
  const relative = path.relative(repoRoot, target).split(path.sep).join('/')
  let stdout = ''
  try {
    stdout = execFileSync(
      process.execPath,
      [oxlintBin, '-c', configPath, '--format', 'json', relative],
      { cwd: repoRoot, encoding: 'utf8' },
    )
  } catch (error) {
    // A non-zero exit is expected for the rejecting fixture; oxlint still
    // prints the JSON report on stdout.
    stdout = error.stdout ?? ''
  }
  const report = JSON.parse(stdout)
  return report.diagnostics ?? []
}

beforeAll(() => {
  mkdirSync(path.join(repoRoot, 'src/features'), { recursive: true })
  for (const probe of probes) {
    writeFileSync(probe.target, readFileSync(probe.source, 'utf8'), 'utf8')
  }
})

afterAll(() => {
  for (const probe of probes) {
    if (existsSync(probe.target)) rmSync(probe.target)
  }
})

describe('notation/no-raw-scientific-notation — enforcement', () => {
  it('rejects raw notation in JSX text, display attributes, children and labels', () => {
    const diagnostics = lintProbe(probes[0].target)

    // t_ref, A_c(0), V_p (title), K_d (child), V_c + k_e0 (labels), and 3 carets.
    expect(diagnostics.length).toBeGreaterThanOrEqual(7)
    const messages = diagnostics.map((diagnostic) => diagnostic.message ?? '')
    for (const expected of ['"t_ref"', '"A_c"', '"V_p"', '"K_d"', '"V_c"', '"k_e0"', '^n']) {
      expect(messages.some((message) => message.includes(expected)), expected).toBe(true)
    }
    expect(messages.every((message) => message.includes('<ScientificText'))).toBe(true)
    expect(messages.some((message) => message.includes('parameterFields.ts'))).toBe(true)
    expect(
      messages.every((message) => message.includes('notation/no-raw-scientific-notation')),
    ).toBe(true)
  })

  it('accepts identifiers, code samples and the approved rendering channels', () => {
    const diagnostics = lintProbe(probes[1].target)
    expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([])
  })
})
