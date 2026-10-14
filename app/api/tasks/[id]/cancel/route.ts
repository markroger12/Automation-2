import { route } from '@/lib/api';
import { requestCancel } from '@/lib/tasks/lifecycle';

export const POST = route({}, async ({ params }) => requestCancel(params.id));
