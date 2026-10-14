import { db, type Tx } from '../db';
import { enqueue, cancelWaitingJobsForTask, wakeArticleJob } from '../queue';
import { log } from '../log';
import { audit } from '../audit';
import { AppError } from '../errors';
import { TERMINAL_STATUSES, type TaskStatus } from '../domain';

/**
 * Task lifecycle operations shared by the dashboard API and the worker.
 * Every operation is idempotent and never deletes content.
 */

/**
 * Make sure exactly one article job exists for the task. Uses the task's
 * version as a run counter (compare-and-set), so concurrent callers (double
 * click, two tabs) cannot create two runs.
 */
export async function ensureArticleRun(taskId: string, reason: string, client: Tx = db, options: { priority?: number } = {}): Promise<'woken' | 'enqueued' | 'busy'> {
  // Serialize per database: the first statement is a no-op write that takes
  // SQLite's write lock, so the check-then-enqueue below cannot interleave with
  // another caller (double click, two tabs, worker self-heal).
  const run = async (tx: Tx) => {
    await tx.$executeRaw`UPDATE "ArticleTask" SET "version" = "version" WHERE "id" = ${taskId}`;
    return ensureArticleRunLocked(taskId, reason, tx, options);
  };
  if ('$transaction' in client && typeof (client as typeof db).$transaction === 'function') {
    return (client as typeof db).$transaction((tx) => run(tx), { timeout: 15_000, maxWait: 15_000 });
  }
  return run(client);
}

async function ensureArticleRunLocked(taskId: string, reason: string, client: Tx, options: { priority?: number }): Promise<'woken' | 'enqueued' | 'busy'> {
  const live = await client.queueJob.findFirst({ where: { taskId, queue: 'article', status: { in: ['WAITING', 'ACTIVE'] } } });
  if (live) {
    if (live.status === 'WAITING') {
      await client.queueJob.update({ where: { id: live.id }, data: { runAt: new Date() } });
      return 'woken';
    }
    return 'busy';
  }
  const task = await client.articleTask.findUniqueOrThrow({ where: { id: taskId }, select: { version: true, websiteId: true, priority: true } });
  await client.articleTask.update({ where: { id: taskId }, data: { version: { increment: 1 } } });
  await enqueue(
    {
      queue: 'article',
      kind: 'article.run',
      idempotencyKey: `article:${taskId}:run:${task.version + 1}`,
      taskId,
      websiteId: task.websiteId,
      priority: options.priority ?? task.priority,
      maxAttempts: 1000,
      payload: { reason },
    },
    client,
  );
  return 'enqueued';
}

/** Cooperative cancellation: flag the task; cancel waiting jobs now. */
export async function requestCancel(taskId: string, client: Tx = db): Promise<{ status: string }> {
  const task = await client.articleTask.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  if (task.status === 'CANCELLED') return { status: 'CANCELLED' };
  if (task.status === 'COMPLETED') throw new AppError(409, 'CONFLICT', 'A verified complete article cannot be cancelled.');
  await client.articleTask.update({ where: { id: taskId }, data: { cancelRequested: true, message: 'Cancellation requested…' } });
  await cancelWaitingJobsForTask(taskId, client);
  await client.chatGPTResponse.updateMany({ where: { taskId, status: 'PENDING' }, data: { status: 'SUPERSEDED', error: 'Task cancelled' } });
  const active = await client.queueJob.count({ where: { taskId, status: 'ACTIVE' } });
  if (active === 0) {
    await client.articleTask.update({ where: { id: taskId }, data: { status: 'CANCELLED', message: 'Cancelled by the owner. Completed content is preserved.' } });
    await log({ category: 'task', taskId, message: 'Task cancelled (no active work).' }, client);
    return { status: 'CANCELLED' };
  }
  await log({ category: 'task', taskId, message: 'Cancellation requested; active work stops at the next safe point.' }, client);
  return { status: task.status };
}

const RETRYABLE: TaskStatus[] = ['FAILED', 'NEEDS_REVIEW', 'CANCELLED', 'LOGIN_REQUIRED', 'PAUSED'];

/**
 * Retry a task from its first unfinished stage. Completed stages and their
 * outputs are kept (no re-sending of successful prompts).
 */
export async function retryTask(taskId: string, client: Tx = db): Promise<{ result: string }> {
  const task = await client.articleTask.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  if (task.legacy) throw new AppError(409, 'RETIRED_WRITER', 'This task belongs to the retired Celebrity Writer 2.0 and is read-only. Create a new task with a supported writer.');
  if (!RETRYABLE.includes(task.status as TaskStatus)) {
    throw new AppError(409, 'CONFLICT', `Only failed, cancelled, paused or review tasks can be retried (current: ${task.status}).`);
  }
  await client.articleStage.updateMany({ where: { taskId, status: { in: ['FAILED', 'RUNNING'] } }, data: { status: 'PENDING', error: null, attempts: 0 } });
  await client.articleTask.update({
    where: { id: taskId },
    data: { status: 'QUEUED', cancelRequested: false, message: 'Retry queued — resuming from the first unfinished stage.', nextAction: null },
  });
  const result = await ensureArticleRun(taskId, 'retry', client);
  await audit('task.retry', 'ArticleTask', taskId, { from: task.status }, client);
  return { result };
}

/** Resume after LOGIN_REQUIRED / PAUSED / approvals without resetting stages. */
export async function resumeTask(taskId: string, reason: string, client: Tx = db): Promise<{ result: string }> {
  const task = await client.articleTask.findUnique({ where: { id: taskId } });
  if (!task) throw new AppError(404, 'NOT_FOUND', 'Task not found.');
  if (TERMINAL_STATUSES.includes(task.status as TaskStatus) && task.status !== 'FAILED') {
    throw new AppError(409, 'CONFLICT', `Task is ${task.status}; nothing to resume.`);
  }
  if (task.legacy) throw new AppError(409, 'RETIRED_WRITER', 'Retired writer tasks are read-only.');
  // Wake ChatGPT jobs that were sleeping because of login/human checks.
  await client.queueJob.updateMany({ where: { taskId, queue: 'chatgpt', status: 'WAITING' }, data: { runAt: new Date() } });
  const result = await ensureArticleRun(taskId, reason, client);
  return { result };
}

/** Resume every task paused for a login of the given scope (called when the session becomes ACTIVE). */
export async function resumeLoginPausedTasks(scope: { websiteId: string } | { chatgpt: true }, client: Tx = db): Promise<number> {
  const where =
    'websiteId' in scope
      ? { status: 'LOGIN_REQUIRED', pausedFor: 'wordpress-login', websiteId: scope.websiteId }
      : { status: { in: ['LOGIN_REQUIRED', 'PAUSED'] }, pausedFor: { in: ['chatgpt-login', 'chatgpt-human-check'] } };
  const tasks = await client.articleTask.findMany({ where, select: { id: true } });
  for (const t of tasks) {
    await client.articleTask.update({ where: { id: t.id }, data: { status: 'QUEUED', pausedFor: null, message: 'Session is active again; resuming.', nextAction: null } });
    await resumeTask(t.id, 'websiteId' in scope ? 'wordpress-session-ready' : 'chatgpt-session-ready', client);
  }
  return tasks.length;
}

export { wakeArticleJob };
