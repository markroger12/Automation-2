import { route } from '@/lib/api';
import { overrideQuality, overrideSchema } from '@/lib/tasks/actions';

export const POST = route({ body: overrideSchema }, async ({ params, body }) => overrideQuality(params.id, body));
