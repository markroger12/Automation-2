import { db } from '@/lib/db';
import { AppError, notFound } from '@/lib/errors';
import { audit } from '@/lib/audit';
import { resaveToWordPress } from '@/lib/tasks/actions';

/**
 * Batch re-save (upgrade 09): articles of one website that stopped at a
 * WordPress step (draft save, Rank Math, verification). Each one gets the
 * same “Save to WordPress again” as the article's WordPress tab: the stored
 * post ID / create marker reconcile with WordPress first, so no duplicate
 * draft is created, and the conflict check still stops on manual WordPress
 * edits (an overwrite is only ever chosen per article).
 */

export interface FailedWordPressTask {
  id: string;
  keyword: string;
  title: string | null;
  status: string;
  stageKey: string;
  stageLabel: string;
  error: string | null;
  wpPostId: number | null;
  updatedAt: string;
}

export async function failedWordPressTasks(websiteId: string): Promise<FailedWordPressTask[]> {
  const rows = await db.articleTask.findMany({
    where: { websiteId, legacy: false, status: { in: ['FAILED', 'NEEDS_REVIEW'] }, stages: { some: { kind: 'wordpress', status: 'FAILED' } } },
    select: { id: true, keyword: true, selectedTitle: true, status: true, wpPostId: true, updatedAt: true, stages: { where: { kind: 'wordpress', status: 'FAILED' }, orderBy: { position: 'asc' }, take: 1, select: { key: true, label: true, error: true } } },
    orderBy: { updatedAt: 'desc' },
    take: 200,
  });
  return rows.map((r) => ({
    id: r.id,
    keyword: r.keyword,
    title: r.selectedTitle,
    status: r.status,
    stageKey: r.stages[0]?.key ?? '',
    stageLabel: r.stages[0]?.label ?? '',
    error: r.stages[0]?.error?.slice(0, 300) ?? null,
    wpPostId: r.wpPostId,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export async function resaveFailedWordPressTasks(websiteId: string, taskIds?: string[]): Promise<{ requeued: string[]; failed: { id: string; error: string }[] }> {
  const site = await db.website.findUnique({ where: { id: websiteId }, include: { wordpressProfile: { select: { sessionState: true } } } });
  if (!site) throw notFound('Website');
  if (!site.active || site.paused) throw new AppError(409, 'WEBSITE_PAUSED', `${site.name} is paused or inactive. Resume it first.`);
  if (site.wordpressProfile?.sessionState === 'LOGIN_REQUIRED' || !site.wordpressProfile) {
    throw new AppError(409, 'LOGIN_REQUIRED', `${site.name} is not logged in to WordPress. Use “Log in” first; a re-save would only stop again.`);
  }
  const candidates = await failedWordPressTasks(websiteId);
  // Only tasks of this list can be re-saved (never an arbitrary ID).
  const chosen = taskIds ? candidates.filter((c) => taskIds.includes(c.id)) : candidates;
  if (!chosen.length) throw new AppError(409, 'NOTHING_TO_RESAVE', 'No article of this website is waiting for a WordPress re-save.');
  const requeued: string[] = [];
  const failed: { id: string; error: string }[] = [];
  for (const t of chosen) {
    try {
      await resaveToWordPress(t.id, { mode: 'resave' });
      requeued.push(t.id);
    } catch (error) {
      failed.push({ id: t.id, error: (error as Error).message });
    }
  }
  await audit('wordpress.batch-resave', 'Website', websiteId, { requeued, failed });
  return { requeued, failed };
}
