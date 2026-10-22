import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { dataPaths } from './paths';

/**
 * Owner report (2026-10-22, malaak compton-rock): an article published today showed in the calendar on tomorrow's
 * slot. The owner had published the draft in WordPress; Force continue then gave the keyword the next free slot, and
 * the scheduler found the post already published: it recorded the real publish time but kept the slot. New
 * publications are fixed where they are recorded (src/wordpress/schedule.ts). This moves the ones recorded before to
 * their real publish time and frees their slot. A backup of the changed rows is written first.
 */
export const PUBLISHED_SLOT_MIGRATION_ID = '2026-10-22-published-at-real-time';

export async function publishedAtRealTime(client: PrismaClient): Promise<Record<string, unknown>> {
  const published = await client.workflowKeyword.findMany({
    where: { status: { in: ['PUBLISHED', 'INDEXING_REQUESTED', 'INDEXED'] }, publishedAt: { not: null }, scheduledAt: { not: null } },
    select: { id: true, keyword: true, scheduledAt: true, publishedAt: true },
  });
  const changed = published.filter((k) => Math.abs(k.publishedAt!.getTime() - k.scheduledAt!.getTime()) >= 60_000);
  let backupFile: string | null = null;
  if (changed.length) {
    const dir = path.join(dataPaths.backups(), 'migrations');
    fs.mkdirSync(dir, { recursive: true });
    backupFile = path.join(dir, `${PUBLISHED_SLOT_MIGRATION_ID}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(changed, null, 2));
  }
  for (const k of changed) {
    await client.slotReservation.deleteMany({ where: { workflowKeywordId: k.id } });
    await client.workflowKeyword.update({ where: { id: k.id }, data: { scheduledAt: k.publishedAt } });
  }
  return { moved: changed.map((k) => ({ keyword: k.keyword, from: k.scheduledAt!.toISOString(), to: k.publishedAt!.toISOString() })), backupFile: backupFile ? path.relative(dataPaths.backups(), backupFile) : null };
}
