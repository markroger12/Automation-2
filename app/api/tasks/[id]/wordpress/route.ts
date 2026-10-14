import { route } from '@/lib/api';
import { resaveToWordPress, wordpressActionSchema } from '@/lib/tasks/actions';

export const POST = route({ body: wordpressActionSchema }, async ({ params, body }) => resaveToWordPress(params.id, body));
