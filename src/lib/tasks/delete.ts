import fs from 'node:fs';
import path from 'node:path';
import { db } from '../db';
import { log } from '../log';
import { audit } from '../audit';
import { AppError } from '../errors';
import { parseJson } from '../json';
import { dataPaths } from '../paths';
import { articleReport, articleReportFilename } from './report';
import { requestCancel } from './lifecycle';

/**
 * Delete articles from this app (owner request: queued and completed articles could not be removed). WordPress is
 * never touched: a saved draft or post stays on the website. Before a task is removed, its full report (stages,
 * prompts, answers, logs) is written to data/backups/deleted-articles, so nothing is lost by a wrong click.
 * A task the worker is running right now is cancelled first and deleted as soon as it stops.
 */

export const deletedArticlesDir = () => path.join(dataPaths.backups(), 'deleted-articles');

export async function deleteTask(taskId: string): Promise<{ status: 'deleted' | 'deleting' }> {
  const task = await db.articleTask.findUnique({ where: { id: taskId }, select: { id: true, keyword: true, slug: true, status: true, options: true } });
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  const active = await db.queueJob.count({ where: { taskId, status: 'ACTIVE' } });
  if (active) {
    // Stops at the next safe point; the engine deletes it then (see deleteIfRequested).
    const options = { ...parseJson<Record<string, unknown>>(task.options, {}), deleteWhenStopped: true };
    await db.articleTask.update({ where: { id: taskId }, data: { options: JSON.stringify(options) } });
    if (task.status !== 'CANCELLED' && task.status !== 'COMPLETED') await requestCancel(taskId).catch(() => undefined);
    await log({ category: 'task', taskId, message: 'Delete requested: the article is deleted as soon as the running step stops.' });
    return { status: 'deleting' };
  }
  await deleteNow(task);
  return { status: 'deleted' };
}

/** Called when a cancelled task stops: deletes it if the owner asked for that while it was running. */
export async function deleteIfRequested(taskId: string): Promise<boolean> {
  const task = await db.articleTask.findUnique({ where: { id: taskId }, select: { id: true, keyword: true, slug: true, status: true, options: true } });
  if (!task || parseJson<Record<string, unknown>>(task.options, {}).deleteWhenStopped !== true) return false;
  await deleteNow(task);
  return true;
}

async function deleteNow(task: { id: string; keyword: string; slug: string | null; status: string }) {
  const dir = deletedArticlesDir();
  fs.mkdirSync(dir, { recursive: true });
  const report = await articleReport(task.id);
  fs.writeFileSync(path.join(dir, `${task.id}-${articleReportFilename(task)}`), JSON.stringify(report, null, 2));
  await db.$transaction(async (tx) => {
    await tx.queueJob.deleteMany({ where: { taskId: task.id, status: { not: 'ACTIVE' } } });
    await tx.campaignRow.updateMany({ where: { taskId: task.id }, data: { taskId: null, status: 'CANCELLED' } });
    const keywords = await tx.workflowKeyword.findMany({ where: { taskId: task.id }, select: { id: true } });
    for (const k of keywords) {
      await tx.slotReservation.deleteMany({ where: { workflowKeywordId: k.id } });
      await tx.workflowKeyword.update({ where: { id: k.id }, data: { taskId: null, status: 'SKIPPED', lastError: 'The article was deleted by you.' } });
    }
    await tx.articleTask.delete({ where: { id: task.id } });
  });
  await audit('task.delete', 'ArticleTask', task.id, { keyword: task.keyword, status: task.status, backup: `${task.id}-${articleReportFilename(task)}` });
  await log({ category: 'task', message: `Article “${task.keyword}” deleted from the app (was ${task.status.toLowerCase()}); its report was saved in data/backups/deleted-articles. WordPress was not changed.` });
}
