/**
 * Worker entry point: `npm run worker` (or `npm run worker:dev` via tsx watch).
 * Exactly one worker may own the data directory (see lock.ts). Only the worker
 * opens automation browsers and processes queue work.
 */
import { loadEnv } from '@/lib/env';

loadEnv();

const { startWorker } = await import('./runtime');

startWorker().catch((error) => {
  console.error(`✖ Worker failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
