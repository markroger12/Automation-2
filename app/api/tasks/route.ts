import { z } from 'zod';
import { route } from '@/lib/api';
import { listTasks, taskListQuerySchema } from '@/lib/tasks/query';
import { createArticleTask } from '@/lib/tasks/create';
import { getExtensionHealth, getWorkerHealth } from '@/lib/health';

export const GET = route({}, async ({ searchParams }) => {
  const query = taskListQuerySchema.parse(Object.fromEntries(searchParams.entries()));
  return listTasks(query);
});

/** Single Article: validate, persist one task with input snapshots, queue exactly one run. */
export const POST = route({ body: z.record(z.string(), z.unknown()) }, async ({ body }) => {
  const { task, created } = await createArticleTask(body, { source: 'SINGLE' });
  const [worker, extension] = await Promise.all([getWorkerHealth(), getExtensionHealth()]);
  const warnings: string[] = [];
  if (worker.state !== 'online') warnings.push('The worker is not running — start npm run dev:all; the task waits safely in the queue.');
  if (extension.state !== 'connected') warnings.push('The ChatGPT extension is not connected — ChatGPT stages wait until Automation Chrome is set up.');
  return { task: { id: task.id, status: task.status }, created, warnings };
});
