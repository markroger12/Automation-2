/**
 * npm run db:rollback-retirement -- <backup-file-name>
 * Restores the values the Celebrity Writer 2.0 retirement migration changed
 * (settings, site overrides, task statuses, cancelled jobs) from its backup in
 * data/backups/migrations/. Nothing is deleted. Stop `npm run dev:all` first;
 * note that the next `npm run setup` applies the retirement again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { dataPaths, resolveDatabaseUrl } from '../src/lib/paths';
import { RETIREMENT_MIGRATION_ID, rollbackRetirement } from '../src/lib/retirement';
import { inspectLock } from '../src/worker/lock';

const dir = path.join(dataPaths.backups(), 'migrations');
const name = process.argv[2];
if (!name) {
  console.log('Usage: npm run db:rollback-retirement -- <backup-file>\n\nAvailable retirement backups:');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(RETIREMENT_MIGRATION_ID)) : [];
  for (const f of files) console.log(`  ${f}`);
  if (!files.length) console.log('  (none — the retirement found nothing to change)');
  process.exit(1);
}
const lock = inspectLock();
if (lock.state === 'held' && lock.alive) {
  console.error(`✖ The worker (PID ${lock.info.pid}) is still running. Stop npm run dev:all first.`);
  process.exit(1);
}
const client = new PrismaClient({ datasources: { db: { url: resolveDatabaseUrl() } } });
rollbackRetirement(client, path.join(dir, path.basename(name)))
  .then((r) => console.log(`✔ Restored ${r.settings} setting row(s), ${r.sites} website override(s), ${r.tasks} task(s), ${r.jobs} job(s).`))
  .catch((error) => {
    console.error('✖ Rollback failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => client.$disconnect());
