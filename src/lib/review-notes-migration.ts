import fs from 'node:fs';
import path from 'node:path';
import type { PrismaClient } from '@prisma/client';
import { dataPaths } from './paths';
import { parseJson } from './json';

const GLOBAL_SETTINGS_KEY = 'global';

/**
 * Owner decision (2026-10-21): the review system is off by default (Settings → Workflow → Hold articles for review).
 * Articles that already stopped as NEEDS_REVIEW only because of review reasons — their WordPress draft was saved and
 * verified — become COMPLETED; the reasons stay on the article page as notes. Anything else (no verified draft, a
 * duplicate keyword, an uncertain prompt) is left as it is. A backup of the changed rows is written first.
 */
export const REVIEW_NOTES_MIGRATION_ID = '2026-10-21-review-reasons-become-notes';

export async function reviewReasonsBecomeNotes(client: PrismaClient): Promise<Record<string, unknown>> {
  const setting = await client.setting.findUnique({ where: { key: GLOBAL_SETTINGS_KEY } }).catch(() => null);
  if (parseJson<{ workflow?: { holdForReview?: boolean } }>(setting?.value, {}).workflow?.holdForReview === true) return { skipped: 'Hold articles for review is on' };
  const tasks = await client.articleTask.findMany({
    where: { status: 'NEEDS_REVIEW', legacy: false, wpPostId: { not: null }, wpVerifiedAt: { not: null } },
    select: { id: true, status: true, message: true, nextAction: true, reviewReasons: true, wpPostId: true, verifiedCompleteAt: true, stages: { where: { key: 'VERIFIED_COMPLETE' }, select: { status: true, outputJson: true } } },
  });
  const changed = tasks.filter((t) => t.stages[0]?.status === 'COMPLETED' && parseJson<{ verified?: boolean }>(t.stages[0].outputJson, {}).verified === true);
  let backupFile: string | null = null;
  if (changed.length) {
    const dir = path.join(dataPaths.backups(), 'migrations');
    fs.mkdirSync(dir, { recursive: true });
    backupFile = path.join(dir, `${REVIEW_NOTES_MIGRATION_ID}.json`);
    fs.writeFileSync(backupFile, JSON.stringify(changed.map(({ stages: _s, ...t }) => t), null, 2));
  }
  const now = new Date();
  for (const t of changed) {
    const notes = parseJson<string[]>(t.reviewReasons, []).length;
    await client.articleTask.update({
      where: { id: t.id },
      data: { status: 'COMPLETED', nextAction: null, message: `Verified WordPress draft #${t.wpPostId}.${notes ? ` ${notes} note(s) on the article page.` : ''}`, ...(t.verifiedCompleteAt ? {} : { verifiedCompleteAt: now }) },
    });
  }
  return { completed: changed.length, backupFile: backupFile ? path.relative(dataPaths.backups(), backupFile) : null };
}
