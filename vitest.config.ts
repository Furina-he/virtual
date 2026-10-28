import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(import.meta.dirname, 'src/shared'),
      '@domain': resolve(import.meta.dirname, 'src/domain'),
    },
  },
  test: { include: ['src/**/*.test.ts', 'tests/golden/**/*.test.ts', 'tools/**/*.test.ts'] },
})
