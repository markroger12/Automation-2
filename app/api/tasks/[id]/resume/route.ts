import { route } from '@/lib/api';
import { resumeTask } from '@/lib/tasks/lifecycle';

export const POST = route({}, async ({ params }) => resumeTask(params.id, 'owner-resume'));
