/**
 * npm run db:restore -- <backup-folder-name>
 * Stop `npm run dev:all` first. The current database is moved aside
 * (data/app.db.before-restore-*), never deleted. Run `npm run db:migrate`
 * afterwards if the backup came from an older version.
 */
import { listBackups, restoreBackup } from '../src/lib/backup';
import { inspectLock } from '../src/worker/lock';

const name = process.argv[2];
if (!name) {
  console.log('Usage: npm run db:restore -- <backup-folder>\n\nAvailable backups:');
  for (const b of listBackups()) console.log(`  ${b.name}  (${(b.sizeBytes / 1024).toFixed(0)} KB${b.manifest?.media ? ', with media' : ''})`);
  process.exit(1);
}
const lock = inspectLock();
if (lock.state === 'held' && lock.alive) {
  console.error(`✖ The worker (PID ${lock.info.pid}) is still running. Stop npm run dev:all before restoring.`);
  process.exit(1);
}
try {
  const result = restoreBackup(name);
  console.log(`✔ Restored from ${result.restoredFrom}`);
  if (result.previousSavedAs) console.log(`  Previous database kept at ${result.previousSavedAs}`);
  console.log('  Next: npm run db:migrate, then npm run dev:all');
} catch (error) {
  console.error('✖ Restore failed:', error instanceof Error ? error.message : error);
  process.exit(1);
}
