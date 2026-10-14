/**
 * npm run db:seed — insert missing defaults only. Owner-edited settings and
 * prompts are never overwritten (see src/lib/seed.ts for the rules).
 */
import { pathToFileURL } from 'node:url';
import { loadEnv } from '../src/lib/env';

export async function runSeed(): Promise<void> {
  loadEnv();
  const { db } = await import('../src/lib/db');
  const { seedAll } = await import('../src/lib/seed');
  try {
    const report = await seedAll(db);
    for (const line of report) console.log(`  ${line}`);
  } finally {
    await db.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  runSeed().catch((error) => {
    console.error('✖', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
