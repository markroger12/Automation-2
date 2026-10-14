import { route } from '@/lib/api';
import { approveTitle, approveTitleSchema } from '@/lib/tasks/actions';

export const POST = route({ body: approveTitleSchema }, async ({ params, body }) => approveTitle(params.id, body));
