import { z } from 'zod';
import { route } from '@/lib/api';
import { approveRevision } from '@/lib/refresh/service';

/** Approve: the worker updates the same WordPress post (live posts need the site switch and the typed acknowledgement). */
export const POST = route({ body: z.object({ acknowledgement: z.string().max(100).optional() }) }, async ({ params, body }) => approveRevision(params.id, body.acknowledgement));
