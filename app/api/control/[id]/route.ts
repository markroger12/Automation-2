import { route } from '@/lib/api';
import { db } from '@/lib/db';
import { notFound } from '@/lib/errors';

export const GET = route({}, async ({ params }) => {
  const job = await db.queueJob.findUnique({
    where: { id: params.id },
    select: { id: true, kind: true, status: true, result: true, error: true, createdAt: true, startedAt: true, finishedAt: true, queue: true },
  });
  if (!job || job.queue !== 'control') throw notFound('Control job');
  let result: unknown = null;
  try {
    result = job.result ? JSON.parse(job.result) : null;
  } catch {
    result = null;
  }
  return { job: { ...job, result } };
});
