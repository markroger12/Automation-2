import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/helpers/isolate-data.ts'],
    // One temporary folder per run, removed at the end (tests/helpers/run-tmp.ts).
    globalSetup: ['tests/helpers/run-tmp.ts'],
    testTimeout: 20000,
    pool: 'forks',
  },
});
