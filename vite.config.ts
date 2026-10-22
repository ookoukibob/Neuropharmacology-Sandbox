import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/tests/setup.ts'],
    // `scripts/**` holds the notation lint rule; its tests live next to it and
    // run in the same suite so the static guard cannot rot unnoticed.
    include: ['src/**/*.test.{ts,tsx}', 'scripts/**/*.test.mjs'],
    exclude: ['node_modules', 'e2e'],
    coverage: {
      provider: 'v8',
      include: [
        'src/domain/**',
        'src/engine/**',
        'src/data/**',
        'src/features/**',
        'src/components/charts/curveAdapter.ts',
      ],
    },
  },
})
