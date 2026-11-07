import { route } from '@/lib/api';
import { notFound } from '@/lib/errors';
import { getTaskDetail, serializeDetail } from '@/lib/tasks/detail';
import { deleteTask } from '@/lib/tasks/delete';

export const GET = route({}, async ({ params }) => {
  const detail = await getTaskDetail(params.id);
  if (!detail) throw notFound('Task');
  return { task: serializeDetail(detail) };
});

/** Deletes the article from this app (its report is backed up first); WordPress is not changed. */
export const DELETE = route({}, async ({ params }) => deleteTask(params.id));
