import { route } from '@/lib/api';
import { notFound } from '@/lib/errors';
import { getTaskDetail, serializeDetail } from '@/lib/tasks/detail';

export const GET = route({}, async ({ params }) => {
  const detail = await getTaskDetail(params.id);
  if (!detail) throw notFound('Task');
  return { task: serializeDetail(detail) };
});
