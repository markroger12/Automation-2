/**
 * Worker entry point: `npm run worker` (or `npm run worker:dev` via tsx watch).
 * Exactly one worker may own the data directory (see lock.ts). Only the worker
 * opens automation browsers and processes queue work.
 */
import { loadEnv } from '@/lib/env';

loadEnv();

const { startWorker } = await import('./runtime');

startWorker().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`✖ Worker failed to start: ${message}`);
  // A database without tables: setup (migrations) has not run on this computer yet.
  if (/does not exist in the current database/.test(message)) console.error('  The database is not set up yet. Run `npm run setup` (or start with `npm run start:all`, which does it), then start again. Your data is never reset.');
  process.exit(1);
});
