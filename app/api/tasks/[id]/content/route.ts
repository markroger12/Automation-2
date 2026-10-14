import { route } from '@/lib/api';
import { contentSchema, saveEditedContent } from '@/lib/tasks/actions';

export const PUT = route({ body: contentSchema }, async ({ params, body }) => saveEditedContent(params.id, body));
