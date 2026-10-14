import { route } from '@/lib/api';
import { listTasks, taskListQuerySchema } from '@/lib/tasks/query';

export const GET = route({}, async ({ searchParams }) => {
  const query = taskListQuerySchema.parse(Object.fromEntries(searchParams.entries()));
  return listTasks(query);
});
