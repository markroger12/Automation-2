import { db } from '../db';
import { medianByKey } from './timeline-math';

/**
 * How long each step of an article usually takes, from this computer's own finished articles (owner request
 * 2026-11-12: a live timeline with what is left). The median of the last finished runs of the same step; a step with
 * fewer than 3 runs gets no estimate, so nothing is ever guessed.
 */
export async function stageEstimates(keys: string[], excludeTaskId?: string): Promise<Record<string, number>> {
  const unique = [...new Set(keys)];
  if (!unique.length) return {};
  const rows = await db.articleStage.findMany({
    where: { key: { in: unique }, status: 'COMPLETED', durationMs: { gt: 0 }, ...(excludeTaskId ? { taskId: { not: excludeTaskId } } : {}) },
    orderBy: { completedAt: 'desc' },
    take: 40 * unique.length,
    select: { key: true, durationMs: true },
  });
  return medianByKey(rows, 40, 3);
}
