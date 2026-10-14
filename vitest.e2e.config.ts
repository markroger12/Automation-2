import { defineConfig } from 'vitest/config';
import path from 'node:path';

/** Opt-in end-to-end tests against a real disposable WordPress (see tests/e2e/). */
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/helpers/isolate-data.ts'],
    testTimeout: 300000,
    hookTimeout: 300000,
    pool: 'forks',
    fileParallelism: false,
  },
});
