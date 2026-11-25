import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'tests/e2e',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}{ext}',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
})
