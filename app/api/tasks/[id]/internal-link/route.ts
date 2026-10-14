import { route } from '@/lib/api';
import { internalLinkSchema, setInternalLink } from '@/lib/tasks/actions';

export const POST = route({ body: internalLinkSchema }, async ({ params, body }) => setInternalLink(params.id, body));
