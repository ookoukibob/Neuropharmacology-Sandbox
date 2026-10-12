import { defineConfig } from '@playwright/test'

/**
 * Dedicated configuration for the NV-1 real-browser crash-durability
 * harness (phase 21). Kept separate from `playwright.config.ts` so the
 * ordinary E2E suite never touches this test's browser-process
 * lifecycle:
 *
 * - the specs launch and KILL their own supervised Chromium processes
 *   against disposable `--user-data-dir` profiles — no fixture-managed
 *   browser, no shared profile with the ordinary suite;
 * - `workers: 1` — each test owns its OS processes and temp profiles;
 * - a generous per-test timeout covers launch + seeding + kill + relaunch
 *   + verification, and doubles as the outermost watchdog.
 *
 * Run with: npm run test:crash
 */
export default defineConfig({
  testDir: './e2e-crash',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  reporter: 'list',
  timeout: 180_000,
  use: {
    baseURL: 'http://localhost:4173',
  },
  webServer: {
    command: 'npm run dev -- --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env['CI'],
  },
})
