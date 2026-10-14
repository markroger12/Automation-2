import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/helpers/isolate-data.ts'],
    testTimeout: 120000,
    hookTimeout: 120000,
    pool: 'forks',
    fileParallelism: false,
  },
});
