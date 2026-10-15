import { route } from '@/lib/api';
import { proposeRevision } from '@/lib/refresh/service';

/** Start a revision from the article's current text (dead links removed automatically; nothing is sent to WordPress). */
export const POST = route({}, async ({ params }) => proposeRevision(params.id));
