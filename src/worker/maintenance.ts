import fs from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { getSettings } from '@/lib/settings';
import { dataPaths } from '@/lib/paths';
import { log } from '@/lib/log';

/**
 * Diagnostics retention (Settings → Advanced → diagnosticsRetentionDays):
 * prunes debug/info log rows and failure screenshots older than the window.
 * Warnings, errors, audit history, articles, prompts and outputs are never
 * deleted.
 */
export async function pruneDiagnostics(now = new Date()): Promise<{ logs: number; screenshots: number }> {
  const settings = await getSettings();
  const cutoff = new Date(now.getTime() - settings.advanced.diagnosticsRetentionDays * 86400_000);
  const { count } = await db.log.deleteMany({ where: { level: { in: ['debug', 'info'] }, createdAt: { lt: cutoff } } });
  let screenshots = 0;
  const dir = dataPaths.screenshots();
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(dir, entry.name);
      try {
        if (fs.statSync(file).mtime < cutoff) {
          fs.rmSync(file, { force: true });
          screenshots++;
        }
      } catch {
        /* locked on Windows — try again next time */
      }
    }
  }
  if (count + screenshots > 0) await log({ category: 'maintenance', message: `Retention: pruned ${count} old debug/info log rows and ${screenshots} screenshots.` });
  return { logs: count, screenshots };
}
