import { route } from '@/lib/api';
import { retryTask } from '@/lib/tasks/lifecycle';

export const POST = route({}, async ({ params }) => retryTask(params.id));
