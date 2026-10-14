import { route } from '@/lib/api';
import { metadataSchema, saveMetadata } from '@/lib/tasks/actions';

export const PUT = route({ body: metadataSchema }, async ({ params, body }) => saveMetadata(params.id, body));
